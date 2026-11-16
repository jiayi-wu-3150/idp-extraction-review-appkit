-- Discovers the extraction schema at runtime. No field name is hardcoded anywhere.
--
-- ai_extract wraps each scalar as {value, confidence_score, citation_ids}. For an
-- ARRAY field the wrapper sits on the leaves instead, so arrays are flattened and
-- each leaf reported as "<field>.<leaf>" -- keyed without the element index, since
-- the index varies per document while the type does not.
WITH src AS (
  SELECT
    t.key   AS field,
    t.value AS field_value,
    schema_of_variant(t.value) LIKE 'ARRAY%' AS is_array,
    CASE
      WHEN schema_of_variant(t.value) LIKE 'ARRAY%' THEN false
      ELSE array_contains(map_keys(from_json(to_json(t.value), 'MAP<STRING,VARIANT>')), 'value')
    END AS is_scalar
  FROM classic_stable_qxxm2v_catalog.idp_review.receipt_extraction_silver_v2
  LATERAL VIEW explode(from_json(to_json(variant_get(response, '$.response')), 'MAP<STRING,VARIANT>')) t AS key, value
),
scalars AS (
  SELECT field AS field_name, schema_of_variant(variant_get(field_value, '$.value')) AS value_type
  FROM src WHERE is_scalar
),
array_leaves AS (
  SELECT concat(s.field, '.', l.key) AS field_name,
         schema_of_variant(variant_get(l.value, '$.value')) AS value_type
  FROM src s
  LATERAL VIEW posexplode(
    CASE WHEN s.is_array THEN from_json(to_json(s.field_value), 'ARRAY<VARIANT>')
         ELSE from_json('[]', 'ARRAY<VARIANT>') END) e AS pos, elem
  LATERAL VIEW explode(from_json(to_json(e.elem), 'MAP<STRING,VARIANT>')) l AS key, value
),
other_nested AS (
  -- Nested objects that are neither scalars nor arrays stay read-only.
  SELECT field AS field_name, schema_of_variant(field_value) AS value_type
  FROM src WHERE NOT is_scalar AND NOT is_array
)
SELECT field_name, min(value_type) AS value_type
FROM (SELECT * FROM scalars UNION ALL SELECT * FROM array_leaves UNION ALL SELECT * FROM other_nested)
GROUP BY field_name
ORDER BY field_name
