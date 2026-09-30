ALTER TABLE upstreams ADD COLUMN chat_completions_reasoning_overrides TEXT NOT NULL DEFAULT '{}';

-- Preserve the reasoning dialect previously selected by the DeepSeek flag.
UPDATE upstreams SET chat_completions_reasoning_overrides = '{"text":"reasoning-content","data":"none"}'
WHERE json_extract(flag_overrides, '$.vendor-deepseek') = 1;

-- The manual-model layer previously overrode the upstream DeepSeek flag.
UPDATE upstreams SET config_json = json_set(config_json, '$.models', json((
  SELECT json_group_array(json(CASE
    WHEN json_type(value, '$.endpoints.openaiChatCompletions') = 'object'
      AND json_type(value, '$.flagOverrides.vendor-deepseek') IN ('true', 'false')
    THEN json_set(value, '$.endpoints.openaiChatCompletions.reasoning', json_object(
      'text', CASE WHEN json_extract(value, '$.flagOverrides.vendor-deepseek') = 1 THEN 'reasoning-content'
                   WHEN upstreams.provider = 'copilot' THEN 'reasoning-text'
                   WHEN upstreams.provider = 'ollama' THEN 'reasoning'
                   ELSE 'reasoning-content' END,
      'data', CASE WHEN json_extract(value, '$.flagOverrides.vendor-deepseek') = 1 THEN 'none'
                   WHEN upstreams.provider = 'copilot' THEN 'reasoning-opaque' ELSE 'none' END))
    ELSE value END)) FROM json_each(config_json, '$.models')
))) WHERE json_type(config_json, '$.models') = 'array';
