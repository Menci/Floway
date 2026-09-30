import { describe, expect, test } from 'vitest';

import { chatField, modelsField } from '../src/model-config.ts';

const profile = {
  default_context_window_tokens: 272000,
  auto_compact_token_limit: null,
  effective_context_window_percent: 95,
  truncation_policy: { mode: 'tokens', limit: 10000 },
  model_messages: { instructions_template: '', tools: { future_tool: { instructions: 'Keep this section.' } } },
  shell_type: 'unified_exec',
  apply_patch_tool_type: 'freeform',
  default_verbosity: 'low',
  default_reasoning_summary: 'none',
  use_responses_lite: false,
  supports_reasoning_effort_updates: false,
  supports_search_tool: true,
  web_search_tool_type: 'text_and_image',
  tool_mode: null,
  multi_agent_version: 'v2',
  multi_agent_reasoning_effort: 'xhigh',
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: true,
  include_apps_usage_instructions: false,
};

describe('Codex model metadata', () => {
  test('preserves the complete profile, false, null, empty instructions and opaque sections', () => {
    const model = { upstreamModelId: 'example', kind: 'chat', endpoints: { openaiResponses: {} }, limits: { max_context_window_tokens: 872000 }, chat: { verbosity: { supported: false }, codex: profile } };
    const parsed = modelsField([model], 'test')[0];
    expect(parsed).toEqual(model);
    expect(modelsField(JSON.parse(JSON.stringify([parsed])), 'test')).toEqual([model]);
  });

  test('keeps selector values open while rejecting malformed capability values', () => {
    expect(chatField({ codex: { tool_mode: 'future_mode' } }, 'test')?.codex?.tool_mode).toBe('future_mode');
    expect(() => chatField({ codex: { use_responses_lite: 'true' } }, 'test')).toThrow(/use_responses_lite/);
    expect(() => chatField({ verbosity: { supported: null } }, 'test')).toThrow(/verbosity/);
    expect(() => chatField({ codex: { typo: true } }, 'test')).toThrow(/unknown fields/);
    expect(() => chatField({ codex: { model_messages: { instructions_template: 3 } } }, 'test')).toThrow(/instructions_template/);
  });

  test('rejects a Codex default above the standard maximum without changing that maximum', () => {
    expect(() => modelsField([{ upstreamModelId: 'example', endpoints: { openaiResponses: {} }, limits: { max_context_window_tokens: 128000 }, chat: { codex: { default_context_window_tokens: 272000 } } }], 'test')).toThrow(/exceeds/);
  });
});
