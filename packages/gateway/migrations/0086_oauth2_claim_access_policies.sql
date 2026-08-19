UPDATE oauth2_providers
SET access_policy_json = '{"logic":"and","conditions":[]}'
WHERE json_extract(access_policy_json, '$.type') = 'allow_all';

UPDATE oauth2_providers
SET access_policy_json = (
  SELECT json_object(
    'logic', 'or',
    'conditions', json_group_array(json_object(
      'field', 'groups',
      'op', 'contains',
      'value', memberships.value
    ))
  )
  FROM json_each(oauth2_providers.access_policy_json, '$.allowedMemberships') AS memberships
)
WHERE json_extract(access_policy_json, '$.type') = 'gitea';
