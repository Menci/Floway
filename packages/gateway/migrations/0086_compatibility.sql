ALTER TABLE upstreams ADD COLUMN compatibility_json TEXT NOT NULL DEFAULT '{}';

-- Preserve explicit DeepSeek flag decisions: on selected its dialect; off
-- forwarded the canonical reasoning_text and reasoning_opaque wire fields.
UPDATE upstreams SET compatibility_json = json_object(
  'openaiChatCompletions', json_object('reasoning', json_object(
    'text', CASE WHEN json_extract(flag_overrides, '$.vendor-deepseek') = 1
                 THEN 'reasoning-content' ELSE 'reasoning-text' END,
    'data', CASE WHEN json_extract(flag_overrides, '$.vendor-deepseek') = 1
                 THEN 'passthrough' ELSE 'reasoning-opaque' END)))
WHERE json_type(flag_overrides, '$.vendor-deepseek') IN ('true', 'false');

-- Explicit manual-model flag decisions must keep overriding the migrated
-- upstream dialect. Fill each channel independently to retain explicit formats.
UPDATE upstreams SET config_json = json_set(config_json, '$.models', json((
  SELECT json_group_array(json(CASE
    WHEN json_type(value, '$.endpoints.openaiChatCompletions') = 'object'
      AND json_type(value, '$.flagOverrides.vendor-deepseek') IN ('true', 'false')
    THEN json_insert(value,
      '$.compatibility.openaiChatCompletions.reasoning.text',
                   CASE WHEN json_extract(value, '$.flagOverrides.vendor-deepseek') = 1 THEN 'reasoning-content'
                   ELSE 'reasoning-text' END,
      '$.compatibility.openaiChatCompletions.reasoning.data',
                   CASE WHEN json_extract(value, '$.flagOverrides.vendor-deepseek') = 1 THEN 'passthrough'
                   ELSE 'reasoning-opaque' END)
    ELSE value END)) FROM json_each(config_json, '$.models')
))) WHERE json_type(config_json, '$.models') = 'array';
