-- Earlier Copilot state could persist the SDK's -1 unlimited sentinel with a
-- false or absent flag. Current readers require the redundant pair to be canonical.
UPDATE upstreams
SET state_json = json_set(
  state_json,
  '$.quotaSnapshot.data.quotas',
  json((
    SELECT json_group_object(
      key,
      json(CASE
        WHEN json_extract(value, '$.entitlement') = -1
          AND json_extract(value, '$.unlimited') IS NOT 1
        THEN json_set(value, '$.unlimited', json('true'))
        ELSE value
      END)
    )
    FROM json_each(state_json, '$.quotaSnapshot.data.quotas')
  ))
)
WHERE provider = 'copilot'
  AND json_type(state_json, '$.quotaSnapshot.data.quotas') = 'object'
  AND EXISTS (
    SELECT 1
    FROM json_each(state_json, '$.quotaSnapshot.data.quotas')
    WHERE json_extract(value, '$.entitlement') = -1
      AND json_extract(value, '$.unlimited') IS NOT 1
  );
