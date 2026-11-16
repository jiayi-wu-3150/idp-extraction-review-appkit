-- @param doc_id STRING
-- One row per reviewable value, carrying its citation box and page image.
-- Scalars yield one row each. ARRAY fields are flattened to one row per leaf
-- ("line_items[0].amount"), because ai_extract puts the
-- {value, confidence_score, citation_ids} wrapper on array leaves rather than on
-- the array, so each leaf is independently reviewable and independently cited.
WITH doc AS (
  SELECT id, response FROM classic_stable_qxxm2v_catalog.idp_review.receipt_extraction_silver_v2 WHERE id = :doc_id
),
top AS (
  SELECT d.id, t.key AS field, t.value AS field_value,
         schema_of_variant(t.value) LIKE 'ARRAY%' AS is_array,
         CASE
           WHEN schema_of_variant(t.value) LIKE 'ARRAY%' THEN false
           ELSE array_contains(map_keys(from_json(to_json(t.value), 'MAP<STRING,VARIANT>')), 'value')
         END AS is_scalar
  FROM doc d
  LATERAL VIEW explode(from_json(to_json(variant_get(d.response, '$.response')), 'MAP<STRING,VARIANT>')) t AS key, value
),
scalar_rows AS (
  SELECT id, field AS path, field AS type_key,
         CAST(NULL AS STRING) AS group_name, CAST(NULL AS INT) AS item_index,
         variant_get(field_value, '$.value', 'STRING')             AS value,
         variant_get(field_value, '$.confidence_score', 'DOUBLE')  AS confidence,
         variant_get(field_value, '$.citation_ids', 'ARRAY<BIGINT>') AS citation_ids
  FROM top WHERE is_scalar
),
leaf_rows AS (
  SELECT p.id,
         concat(p.field, '[', e.pos, '].', l.key) AS path,
         concat(p.field, '.', l.key)              AS type_key,
         p.field AS group_name, CAST(e.pos AS INT) AS item_index,
         variant_get(l.value, '$.value', 'STRING')             AS value,
         variant_get(l.value, '$.confidence_score', 'DOUBLE')  AS confidence,
         variant_get(l.value, '$.citation_ids', 'ARRAY<BIGINT>') AS citation_ids
  FROM top p
  LATERAL VIEW posexplode(
    CASE WHEN p.is_array THEN from_json(to_json(p.field_value), 'ARRAY<VARIANT>')
         ELSE from_json('[]', 'ARRAY<VARIANT>') END) e AS pos, elem
  LATERAL VIEW explode(from_json(to_json(e.elem), 'MAP<STRING,VARIANT>')) l AS key, value
),
other_rows AS (
  SELECT id, field AS path, field AS type_key,
         CAST(NULL AS STRING) AS group_name, CAST(NULL AS INT) AS item_index,
         to_json(field_value) AS value,
         CAST(NULL AS DOUBLE) AS confidence,
         CAST(NULL AS ARRAY<BIGINT>) AS citation_ids
  FROM top WHERE NOT is_scalar AND NOT is_array
),
all_fields AS (
  SELECT * FROM scalar_rows UNION ALL SELECT * FROM leaf_rows UNION ALL SELECT * FROM other_rows
),
citations AS (
  SELECT d.id,
         variant_get(c.value, '$.id', 'BIGINT')                   AS citation_id,
         variant_get(c.value, '$.bbox[0].coord', 'ARRAY<BIGINT>') AS coord,
         variant_get(c.value, '$.bbox[0].page_id', 'BIGINT')      AS page_id
  FROM doc d
  LATERAL VIEW explode(from_json(to_json(variant_get(d.response, '$.metadata.citations')), 'ARRAY<VARIANT>')) c AS value
),
pages AS (
  SELECT d.id,
         variant_get(p.value, '$.id', 'BIGINT')        AS page_id,
         variant_get(p.value, '$.image_uri', 'STRING') AS image_uri
  FROM doc d
  LATERAL VIEW explode(from_json(to_json(variant_get(d.response, '$.metadata.pages')), 'ARRAY<VARIANT>')) p AS value
),
-- Fallback so every row carries an image, even values with no citation.
first_page AS (
  SELECT id, min_by(image_uri, page_id) AS image_uri FROM pages GROUP BY id
),
-- Review state comes from the log, never from client session state, so a
-- reviewer's own corrections and attribution survive a refresh.
--
-- Scoped to `current_user()`: a reviewer sees only their own review state, never
-- another's, so one reviewer's answer cannot anchor the next one's judgement.
-- This requires the file to be named `.obo.sql`, which makes AppKit execute it
-- as the signed-in user; as the service principal `current_user()` would be the
-- app's identity and the filter would match nothing. Cross-reviewer resolution
-- is the job of the `_reviewed` view, not of this app.
--
-- The log is append-only, so the latest event per value wins. Joined through
-- `doc` rather than by repeating :doc_id as a parameter.
latest_review AS (
  SELECT r.field_path,
         max_by(r.corrected_value, r.reviewed_at) AS reviewed_value,
         max_by(r.reviewer, r.reviewed_at)        AS reviewer,
         max_by(r.changed, r.reviewed_at)         AS human_changed,
         max(r.reviewed_at)                       AS reviewed_at
  FROM classic_stable_qxxm2v_catalog.idp_review.review_events r
  JOIN doc d ON d.id = r.document_id
  WHERE r.reviewer = current_user()
  GROUP BY r.field_path
)
SELECT
  f.path, f.type_key, f.group_name, f.item_index,
  -- `value` is what the reviewer should see and edit: their agreed value if
  -- there is one, the model's otherwise. `model_value` is kept alongside so a
  -- correction can show what it replaced.
  coalesce(lr.reviewed_value, f.value) AS value,
  f.value                              AS model_value,
  f.confidence,
  lr.reviewer      AS reviewer,
  lr.reviewed_at   AS reviewed_at,
  lr.human_changed AS human_changed,
  c.coord, c.page_id,
  regexp_extract(coalesce(p.image_uri, fp.image_uri), '([^/]+)$', 1) AS image_file
FROM all_fields f
LEFT JOIN citations    c  ON c.id = f.id AND c.citation_id = get(f.citation_ids, 0)
LEFT JOIN pages        p  ON p.id = f.id AND p.page_id = c.page_id
LEFT JOIN first_page   fp ON fp.id = f.id
LEFT JOIN latest_review lr ON lr.field_path = f.path
ORDER BY coalesce(f.group_name, f.path), f.item_index, f.path
