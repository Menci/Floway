import { describe, expect, test } from 'vitest';

import type { CatalogModel, CodexCatalogCapabilities } from '../../../src/data-plane/codex/catalog.ts';
import { synthesizeCatalogEntry } from '../../../src/data-plane/codex/synthesize.ts';
import type { InternalModel, ProviderModel } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const base: InternalModel = {
  id: 'deepseek-v4-pro',
  display_name: 'DeepSeek V4 Pro',
  kind: 'chat',
  limits: { max_context_window_tokens: 128000 },
  endpoints: { openaiChatCompletions: {} },
  providerModels: {},
};

// A realistic bundled entry — richer than the miss-path BASELINE and used as
// `source` when the caller matched the registry model against the codex
// bundled catalog.
const bundledBase: CatalogModel = {
  slug: 'gpt-5.5',
  display_name: 'GPT-5.5',
  priority: 1,
  visibility: 'list',
  input_modalities: ['text', 'image'],
  supports_image_detail_original: true,
  web_search_tool_type: 'text_and_image',
  supported_reasoning_levels: [{ effort: 'medium', description: '' }],
  default_reasoning_level: 'medium',
  context_window: 272_000,
  max_context_window: 272_000,
  service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
  base_instructions: 'BUNDLED PROMPT',
  truncation_policy: { mode: 'tokens', limit: 20000 },
};

const ultraCapabilities: CodexCatalogCapabilities = {
  ultraReasoningLevel: { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
};

describe('synthesizeCatalogEntry', () => {
  test('returns hardcoded baseline for a text-only chat model', () => {
    const entry = synthesizeCatalogEntry(base);
    expect(entry.slug).toBe('deepseek-v4-pro');
    expect(entry.display_name).toBe('DeepSeek V4 Pro');
    expect(entry.context_window).toBe(128000);
    expect(entry.max_context_window).toBe(128000);
    expect(entry.input_modalities).toEqual(['text']);
    expect(entry.supports_image_detail_original).toBe(false);
    expect(entry.web_search_tool_type).toBe('text');
    expect(entry.shell_type).toBe('shell_command');
    expect(entry.support_verbosity).toBe(false);
    expect(entry).not.toHaveProperty('prefer_websockets');
    expect(entry.supports_parallel_tool_calls).toBe(true);
    expect(entry.supports_reasoning_summaries).toBe(false);
    expect(entry.supports_reasoning_summary_parameter).toBe(false);
    expect(entry.apply_patch_tool_type).toBeNull();
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.default_reasoning_level).toBeUndefined();
    expect(entry.truncation_policy).toEqual({ mode: 'tokens', limit: 10000 });
    expect(entry.visibility).toBe('list');
    expect(entry.priority).toBe(0);
    expect(entry.service_tiers).toEqual([]);
    // Synthesized models get a vendored Codex-CLI agent prompt (adapted from
    // openai/codex's gpt-5.5 entry) — see synthesized-base-instructions.ts.
    // The opening paragraph names the routed model so an introspection
    // question resolves against it rather than the "Codex" persona's
    // trained-in GPT lineage association.
    expect(typeof entry.base_instructions).toBe('string');
    expect(entry.base_instructions as string).toContain('You are Codex, a coding agent running in the Codex CLI.');
    expect(entry.base_instructions as string).toContain('the model named "DeepSeek V4 Pro"');
    expect(entry.base_instructions as string).toContain('The exact model ID is "deepseek-v4-pro"');
    expect(entry.model_messages?.instructions_template).toBe(entry.base_instructions);
  });

  test.each([
    { max_context_window_tokens: 1000000, max_prompt_tokens: 936000 },
    { max_prompt_tokens: 936000 },
  ])('uses the provider input cap for both windows: %j', limits => {
    const entry = synthesizeCatalogEntry({ ...base, limits });
    expect(entry.context_window).toBe(936000);
    expect(entry.max_context_window).toBe(936000);
  });

  test.each([
    ['false', false],
    ['an unstated value', undefined],
  ] as const)('rejects original detail when one of several providers reports %s', (_, imageDetailOriginal) => {
    const providerModel = (value: boolean | undefined): ProviderModel => stubProviderModel({
      id: 'gpt-5.5',
      upstreamModelId: 'gpt-5.5',
      endpoints: { openaiResponses: {} },
      ...(value === undefined ? {} : { chat: { image_detail_original: value } }),
    });
    const accepting = providerModel(true);
    const rejecting = providerModel(imageDetailOriginal);

    for (const providerModels of [{ accepting, rejecting }, { rejecting, accepting }]) {
      const entry = synthesizeCatalogEntry({ ...base, chat: accepting.chat, providerModels }, bundledBase);
      expect(entry.supports_image_detail_original).toBe(false);
    }
  });

  test('adds Ultra and multi-agent v2 when the client supports Ultra and the model supports Max', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { effort: { supported: ['low', 'max'], default: 'low' } } },
    }, undefined, ultraCapabilities);
    expect(entry.supported_reasoning_levels).toEqual([
      { effort: 'low', description: '' },
      { effort: 'max', description: '' },
      { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
    ]);
    expect(entry.multi_agent_version).toBe('v2');
    expect(entry.multi_agent_reasoning_effort).toBe('max');
  });

  describe('with a bundled base', () => {
    test('bundled input_modalities are preserved without inheriting image-detail support', () => {
      const entry = synthesizeCatalogEntry(base, bundledBase);
      expect(entry.input_modalities).toEqual(['text', 'image']);
      expect(entry.supports_image_detail_original).toBe(false);
      expect(entry.web_search_tool_type).toBe('text_and_image');
    });

    test.each([
      { efforts: ['max', 'high', 'ultra'], expected: 'high' },
      { efforts: ['high', 'ultra', 'vendor-specific'], expected: 'vendor-specific' },
      { efforts: ['vendor-specific', 'ultra'], expected: 'vendor-specific' },
      { efforts: ['ultra', 'none'], expected: 'none' },
    ])('maps Ultra to the last non-Ultra effort in $efforts', ({ efforts, expected }) => {
      const supportedReasoning = efforts.map(effort => ({ effort, description: effort }));
      const entry = synthesizeCatalogEntry(base, {
        ...bundledBase,
        supported_reasoning_levels: supportedReasoning,
        default_reasoning_level: 'none',
        multi_agent_version: 'v2',
      });
      expect(entry.multi_agent_reasoning_effort).toBe(expected);
      expect(entry.supported_reasoning_levels).toEqual(supportedReasoning);
      expect(entry.default_reasoning_level).toBe('none');
      expect(entry.multi_agent_version).toBe('v2');
    });

    test('uses registry reasoning support when deciding whether to map Ultra to Max', () => {
      const entry = synthesizeCatalogEntry({
        ...base,
        chat: { reasoning: { effort: { supported: ['xhigh'], default: 'xhigh' } } },
      }, {
        ...bundledBase,
        supported_reasoning_levels: [
          { effort: 'xhigh', description: 'Extra high' },
          { effort: 'max', description: 'Maximum' },
          { effort: 'ultra', description: 'Existing Ultra' },
        ],
        multi_agent_reasoning_effort: 'xhigh',
      }, ultraCapabilities);
      expect(entry.supported_reasoning_levels).toEqual([{ effort: 'xhigh', description: '' }]);
      expect(entry.default_reasoning_level).toBe('xhigh');
      expect(entry.multi_agent_reasoning_effort).toBe('xhigh');
    });

    test('service_tiers is a hard override — bundled tiers do not survive when registry has none', () => {
      // Bundled entries may advertise OpenAI 1p tiers Floway cannot bill;
      // publishing them without registry-side prices would surface a
      // toggle we could not honor. Registry-derived tiers (from
      // model.pricing.entries) always win, even when the registry list is empty.
      const entry = synthesizeCatalogEntry(base, bundledBase);
      expect(entry.service_tiers).toEqual([]);
    });
  });
});
