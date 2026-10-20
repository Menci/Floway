WITH ranked AS (
  SELECT id, row_number() OVER (ORDER BY sort_order, created_at, id) - 1 AS normalized_sort_order
  FROM upstreams
)
UPDATE upstreams
SET sort_order = (SELECT normalized_sort_order FROM ranked WHERE ranked.id = upstreams.id);
