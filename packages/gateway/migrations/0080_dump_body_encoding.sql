UPDATE dump_records
SET request_body_descriptor = json_set(request_body_descriptor, '$.encoding', 'gzip')
WHERE request_body_descriptor IS NOT NULL;

UPDATE dump_records
SET response_body_descriptor = json_set(response_body_descriptor, '$.encoding', 'gzip')
WHERE response_body_descriptor IS NOT NULL;
