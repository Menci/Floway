-- Refresh ownership and the catalog it protects share one row so claims and
-- catalog publication can be fenced by a single atomic update.
ALTER TABLE upstreams ADD COLUMN models_refresh_json TEXT NULL CHECK (
  models_refresh_json IS NULL OR coalesce((
    json_valid(models_refresh_json) = 1
    AND json_type(models_refresh_json, '$.failCount') IN ('integer', 'real')
    AND json_extract(models_refresh_json, '$.failCount') >= 0
    AND json_extract(models_refresh_json, '$.failCount') = CAST(json_extract(models_refresh_json, '$.failCount') AS INTEGER)
    AND json_type(models_refresh_json, '$.retryAt') IN ('integer', 'real')
    AND json_extract(models_refresh_json, '$.retryAt') >= 0
    AND json_extract(models_refresh_json, '$.retryAt') = CAST(json_extract(models_refresh_json, '$.retryAt') AS INTEGER)
    AND (
      (
        json_type(models_refresh_json, '$.claimToken') = 'null'
        AND json_type(models_refresh_json, '$.claimedAt') = 'null'
      ) OR (
        json_type(models_refresh_json, '$.claimToken') = 'text'
        AND length(json_extract(models_refresh_json, '$.claimToken')) > 0
        AND json_type(models_refresh_json, '$.claimedAt') IN ('integer', 'real')
        AND json_extract(models_refresh_json, '$.claimedAt') >= 0
        AND json_extract(models_refresh_json, '$.claimedAt') = CAST(json_extract(models_refresh_json, '$.claimedAt') AS INTEGER)
      )
    )
  ), 0) = 1
);
