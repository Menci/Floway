ALTER TABLE oauth2_providers
ADD COLUMN access_denied_message TEXT NOT NULL DEFAULT '';

ALTER TABLE oauth2_providers
ADD COLUMN registration_upstream_ids TEXT
CHECK (
  registration_upstream_ids IS NULL
  OR (
    json_valid(registration_upstream_ids)
    AND json_type(registration_upstream_ids) = 'array'
    AND json_array_length(registration_upstream_ids) > 0
  )
);

ALTER TABLE oauth2_handoffs
ADD COLUMN registration_upstream_ids TEXT
CHECK (
  registration_upstream_ids IS NULL
  OR (
    json_valid(registration_upstream_ids)
    AND json_type(registration_upstream_ids) = 'array'
    AND json_array_length(registration_upstream_ids) > 0
  )
);
