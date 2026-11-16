-- One-time setup for the review app. Run this once against the warehouse the
-- app uses, replacing the two table names with your own.
--
--   <REVIEW_LOG_TABLE>  the append-only log the app writes   (REVIEW_LOG_TABLE)
--   <EXTRACT_TABLE>     your ai_extract output table          (EXTRACT_TABLE)

-- 1. The review log. Append-only: the app never updates or deletes a row, and
-- never writes to the extraction table, so this doubles as an audit trail and
-- as a labelled dataset for MLflow evaluation.
CREATE TABLE IF NOT EXISTS <REVIEW_LOG_TABLE> (
  reviewed_at     TIMESTAMP,
  reviewer        STRING,
  document_id     STRING,
  field_path      STRING,
  original_value  STRING,
  corrected_value STRING,
  confidence      DOUBLE,
  changed         BOOLEAN
)
CLUSTER BY (document_id);

-- 2. Final values, for everything downstream of review.
--
-- The log alone answers "what did a human do"; consumers also need "what is the
-- agreed value now". Deriving it in a view keeps one writer and no staleness.
-- The explode mirrors document.sql: scalars yield one row, ARRAY fields one row
-- per leaf, because ai_extract puts the {value, confidence_score, citation_ids}
-- wrapper on array leaves rather than on the array.
--
-- Swap CREATE VIEW for CREATE MATERIALIZED VIEW if the corpus is large enough
-- that consumers should not pay for the explode on every read.
CREATE OR REPLACE VIEW <EXTRACT_TABLE>_reviewed AS
WITH top AS (
  SELECT id, t.key AS field, t.value AS field_value,
         schema_of_variant(t.value) LIKE 'ARRAY%' AS is_array,
         CASE
           WHEN schema_of_variant(t.value) LIKE 'ARRAY%' THEN false
           ELSE array_contains(map_keys(from_json(to_json(t.value), 'MAP<STRING,VARIANT>')), 'value')
         END AS is_scalar
  FROM <EXTRACT_TABLE>
  LATERAL VIEW explode(from_json(to_json(variant_get(response, '$.response')), 'MAP<STRING,VARIANT>')) t AS key, value
),
scalar_leaves AS (
  SELECT id, field AS path, field AS type_key,
         variant_get(field_value, '$.value', 'STRING')            AS model_value,
         variant_get(field_value, '$.confidence_score', 'DOUBLE') AS confidence
  FROM top WHERE is_scalar
),
array_leaves AS (
  SELECT p.id,
         concat(p.field, '[', e.pos, '].', l.key) AS path,
         concat(p.field, '.', l.key)              AS type_key,
         variant_get(l.value, '$.value', 'STRING')            AS model_value,
         variant_get(l.value, '$.confidence_score', 'DOUBLE') AS confidence
  FROM top p
  LATERAL VIEW posexplode(
    CASE WHEN p.is_array THEN from_json(to_json(p.field_value), 'ARRAY<VARIANT>')
         ELSE from_json('[]', 'ARRAY<VARIANT>') END) e AS pos, elem
  LATERAL VIEW explode(from_json(to_json(e.elem), 'MAP<STRING,VARIANT>')) l AS key, value
),
leaves AS (
  SELECT * FROM scalar_leaves UNION ALL SELECT * FROM array_leaves
),
-- Latest event wins. The log is append-only, so a value corrected twice has
-- two rows and only the most recent one is the agreed value.
latest AS (
  SELECT document_id, field_path,
         max_by(corrected_value, reviewed_at) AS human_value,
         max_by(reviewer, reviewed_at)        AS reviewer,
         max_by(changed, reviewed_at)         AS changed,
         max(reviewed_at)                     AS reviewed_at
  FROM <REVIEW_LOG_TABLE>
  GROUP BY document_id, field_path
)
SELECT
  l.id                                       AS document_id,
  l.path                                     AS field_path,
  l.type_key                                 AS field_type_key,
  coalesce(h.human_value, l.model_value)     AS value,
  l.model_value                              AS model_value,
  l.confidence                               AS model_confidence,
  h.reviewer IS NOT NULL                     AS human_reviewed,
  coalesce(h.changed, false)                 AS human_changed,
  h.reviewer                                 AS reviewer,
  h.reviewed_at                              AS reviewed_at
FROM leaves l
LEFT JOIN latest h ON h.document_id = l.id AND h.field_path = l.path
