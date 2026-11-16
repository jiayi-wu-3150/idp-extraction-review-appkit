-- Review queue. One badge per document: how many values are still unapproved,
-- counting down to zero as review events land. Counts scalars and flattened
-- array leaves alike, since both are independently reviewable. Read-only
-- nested objects are excluded.
--
-- Deliberately no per-document confidence figure. The obvious candidates all
-- mislead: an average hides the one bad value in a document of good ones, and
-- a minimum reads as "100% done" when every value happens to score 1.0.
-- Progress is a count of outstanding work, not a model score.
WITH top AS (
  SELECT id, t.key AS field, t.value AS field_value,
         schema_of_variant(t.value) LIKE 'ARRAY%' AS is_array,
         CASE
           WHEN schema_of_variant(t.value) LIKE 'ARRAY%' THEN false
           ELSE array_contains(map_keys(from_json(to_json(t.value), 'MAP<STRING,VARIANT>')), 'value')
         END AS is_scalar
  FROM classic_stable_qxxm2v_catalog.idp_review.receipt_extraction_silver_v2
  LATERAL VIEW explode(from_json(to_json(variant_get(response, '$.response')), 'MAP<STRING,VARIANT>')) t AS key, value
),
scalar_leaves AS (
  SELECT id, field AS path,
         variant_get(field_value, '$.confidence_score', 'DOUBLE') AS confidence
  FROM top WHERE is_scalar
),
array_leaves AS (
  SELECT p.id,
         concat(p.field, '[', e.pos, '].', l.key) AS path,
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
-- The log is append-only, so a value may carry several events. One row per
-- value is all this join needs.
--
-- Scoped to `current_user()` so the queue counts this reviewer's outstanding
-- work only. A document another reviewer has already cleared still appears
-- here, which is deliberate: reviewers work blind of each other, and the
-- `_reviewed` view is where the answers are reconciled. Requires `.obo.sql`.
reviewed AS (
  SELECT document_id, field_path
  FROM classic_stable_qxxm2v_catalog.idp_review.review_events
  WHERE reviewer = current_user()
  GROUP BY document_id, field_path
)
SELECT l.id,
       count_if(r.field_path IS NULL)                            AS n_unreviewed,
       count_if(r.field_path IS NULL AND l.confidence IS NULL)    AS n_unresolved,
       min(l.confidence)                                         AS min_confidence
FROM leaves l
LEFT JOIN reviewed r ON r.document_id = l.id AND r.field_path = l.path
GROUP BY l.id
-- Most outstanding work first; within that, documents the model was least
-- sure about.
ORDER BY n_unreviewed DESC, n_unresolved DESC, min_confidence ASC
