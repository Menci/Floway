import type { CodexChatModelInfo, PublicModelLimits } from '@floway-dev/protocols/common';

export const assertCodexContextWindow = (profile: CodexChatModelInfo | undefined, limits: PublicModelLimits | undefined, label: string): void => {
  const defaultWindow = profile?.default_context_window_tokens;
  for (const key of ['max_context_window_tokens', 'max_prompt_tokens'] as const) {
    const bound = limits?.[key];
    if (defaultWindow !== undefined && bound !== undefined && defaultWindow > bound) {
      throw new RangeError(`${label}.chat.codex.default_context_window_tokens exceeds limits.${key}`);
    }
  }
};

const recordField = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
};

const positiveInteger = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return value;
};

export const codexChatField = (value: unknown, label: string): CodexChatModelInfo => {
  const record = recordField(value, label);
  const result: CodexChatModelInfo = {};
  for (const key of ['default_context_window_tokens', 'auto_compact_token_limit', 'effective_context_window_percent'] as const) {
    const item = record[key];
    if (item === undefined) continue;
    if (key === 'auto_compact_token_limit' && item === null) result[key] = null;
    else result[key] = positiveInteger(item, `${label}.${key}`);
  }
  if (result.effective_context_window_percent !== undefined && result.effective_context_window_percent > 100) {
    throw new RangeError(`${label}.effective_context_window_percent must not exceed 100`);
  }
  for (const key of ['shell_type', 'default_reasoning_summary', 'web_search_tool_type', 'apply_patch_tool_type', 'default_verbosity', 'tool_mode', 'multi_agent_version', 'multi_agent_reasoning_effort'] as const) {
    const item = record[key];
    if (item === undefined) continue;
    if (item === null && key !== 'shell_type' && key !== 'default_reasoning_summary' && key !== 'web_search_tool_type') result[key] = null;
    else {
      if (typeof item !== 'string' || item.length === 0) throw new TypeError(`${label}.${key} must be a non-empty string`);
      result[key] = item;
    }
  }
  for (const key of ['use_responses_lite', 'supports_reasoning_effort_updates', 'supports_search_tool', 'include_skills_usage_instructions', 'include_plugin_usage_instructions', 'include_apps_usage_instructions'] as const) {
    const item = record[key];
    if (item === undefined) continue;
    if (typeof item !== 'boolean') throw new TypeError(`${label}.${key} must be a boolean`);
    result[key] = item;
  }
  if (record.truncation_policy !== undefined) {
    const policy = recordField(record.truncation_policy, `${label}.truncation_policy`);
    if (policy.mode !== 'tokens' && policy.mode !== 'bytes') throw new TypeError(`${label}.truncation_policy.mode must be tokens or bytes`);
    result.truncation_policy = { mode: policy.mode, limit: positiveInteger(policy.limit, `${label}.truncation_policy.limit`) };
  }
  if (record.model_messages !== undefined) {
    const messages = recordField(record.model_messages, `${label}.model_messages`);
    if (messages.instructions_template !== undefined && messages.instructions_template !== null && typeof messages.instructions_template !== 'string') {
      throw new TypeError(`${label}.model_messages.instructions_template must be a string or null`);
    }
    result.model_messages = { ...messages };
  }
  const unknown = Object.keys(record).filter(key => record[key] !== undefined && !Object.hasOwn(result, key));
  if (unknown.length) throw new TypeError(`${label} has unknown fields`);
  return result;
};
