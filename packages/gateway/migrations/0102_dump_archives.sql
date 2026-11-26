-- Retirement and collection remain owned by the dump and spilled-file triggers.
-- Clear a legacy reference before deletion if a retained archive owns its file.
WITH surviving_files AS (
  SELECT json_extract(response_body_descriptor, '$.key') AS file_key
  FROM dump_records
  WHERE json_extract(response_body_descriptor, '$.type') = 'archive'
)
UPDATE dump_records
SET request_body_descriptor = CASE
      WHEN json_extract(request_body_descriptor, '$.key') IN surviving_files THEN NULL
      ELSE request_body_descriptor
    END,
    response_body_descriptor = CASE
      WHEN json_extract(response_body_descriptor, '$.key') IN surviving_files THEN NULL
      ELSE response_body_descriptor
    END,
    response_upstream_body_descriptor = CASE
      WHEN json_extract(response_upstream_body_descriptor, '$.key') IN surviving_files THEN NULL
      ELSE response_upstream_body_descriptor
    END
WHERE COALESCE(json_extract(response_body_descriptor, '$.type'), '') <> 'archive'
  AND EXISTS (
    SELECT 1 FROM surviving_files
    WHERE file_key IN (
      json_extract(request_body_descriptor, '$.key'),
      json_extract(response_body_descriptor, '$.key'),
      json_extract(response_upstream_body_descriptor, '$.key')
    )
  );

DELETE FROM dump_records
WHERE COALESCE(json_extract(response_body_descriptor, '$.type'), '') <> 'archive';
