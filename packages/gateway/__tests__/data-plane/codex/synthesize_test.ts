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
  test('synthesizes a text-only entry that names the routed model', () => {
    const entry = synthesizeCatalogEntry(base);
    expect(entry.slug).toBe('deepseek-v4-pro');
    expect(entry.display_name).toBe('DeepSeek V4 Pro');
    expect(entry.context_window).toBe(128000);
    expect(entry.max_context_window).toBe(128000);
    expect(entry.input_modalities).toEqual(['text']);
    expect(entry.supports_image_detail_original).toBe(false);
    expect(entry.web_search_tool_type).toBe('text');
    expect(entry.multi_agent_version).toBe('v2');
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.service_tiers).toEqual([]);
    // Synthesized models get a vendored Codex-CLI agent prompt (adapted from
    // openai/codex's gpt-5.5 entry) — see synthesized-base-instructions.ts.
    // The opening paragraph names the routed model so an introspection
    // question resolves against it rather than the "Codex" persona's
    // trained-in GPT lineage association.
    expect(entry.base_instructions as string).toContain('DeepSeek V4 Pro');
    expect(entry.base_instructions as string).toContain('deepseek-v4-pro');
    expect(entry.model_messages?.instructions_template).toBe(entry.base_instructions);
  });

  test('uses the provider input cap for both windows', () => {
    const entry = synthesizeCatalogEntry({ ...base, limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 936000 } });
    expect(entry.context_window).toBe(936000);
    expect(entry.max_context_window).toBe(936000);
  });

  test('private Codex metadata can leave the maximum context window unstated', () => {
    const entry = synthesizeCatalogEntry(base, bundledBase, {}, [], { metadata: { context_window: 200_000 } });
    expect(entry.context_window).toBe(200_000);
    expect(Object.hasOwn(entry, 'max_context_window')).toBe(false);
  });

  test('a matching client snapshot alone cannot grant audio input', () => {
    const entry = synthesizeCatalogEntry(base, { ...bundledBase, input_modalities: ['text', 'audio'] }, { audioInput: true });
    expect(entry.input_modalities).toEqual(['text']);
  });

  test('does not advertise Codex audio on a translated route', () => {
    const entry = synthesizeCatalogEntry({ ...base, endpoints: { anthropicMessages: {} }, chat: { modalities: { input: ['text', 'audio'], output: ['text'] } } }, undefined, { audioInput: true });
    expect(entry.input_modalities).toEqual(['text']);
  });

  test('audio requires native Responses and audio input on every chat fallback', () => {
    const chat: NonNullable<ProviderModel['chat']> = { modalities: { input: ['text', 'audio'], output: ['text'] } };
    const primary = stubProviderModel({ endpoints: { openaiResponses: {} }, chat });
    const listed = (fallback: ProviderModel) => synthesizeCatalogEntry({ ...base, endpoints: primary.endpoints, chat, providerModels: { primary, fallback } }, undefined, { audioInput: true }).input_modalities;
    expect(listed(primary)).toEqual(['text', 'audio']);
    expect(listed({ ...primary, endpoints: { anthropicMessages: {} } })).toEqual(['text']);
    expect(listed({ ...primary, chat: { modalities: { input: ['text'], output: ['text'] } } })).toEqual(['text']);
  });

  test('rejects original detail when one of several providers does not state it', () => {
    const draft: Partial<ProviderModel> = {
      id: 'gpt-5.5',
      upstreamModelId: 'gpt-5.5',
      endpoints: { openaiResponses: {} },
    };
    const chat = { image_detail_original: true };
    const accepting = stubProviderModel({ ...draft, chat });
    const rejecting = stubProviderModel(draft);

    for (const providerModels of [{ accepting, rejecting }, { rejecting, accepting }]) {
      const entry = synthesizeCatalogEntry({ ...base, chat, providerModels }, bundledBase);
      expect(entry.supports_image_detail_original).toBe(false);
    }
  });

  test.each(['max', 'xhigh'])('adds Ultra and maps it to the last thinking preset %s', effort => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { effort: { supported: ['low', effort, 'none'], default: 'low' } } },
    }, undefined, ultraCapabilities);
    expect(entry.supported_reasoning_levels).toEqual([
      { effort: 'low', description: '' },
      { effort, description: '' },
      { effort: 'none', description: '' },
      ultraCapabilities.ultraReasoningLevel,
    ]);
    expect(entry.multi_agent_version).toBe('v2');
    expect(entry.multi_agent_reasoning_effort).toBe(effort);
  });

  test.each([
    ['none-only models', 'none', ultraCapabilities],
    ['clients without confirmed Ultra support', 'xhigh', {}],
  ] as const)('preserves the advertised presets for %s', (_scenario, effort, capabilities) => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { effort: { supported: [effort], default: effort } } },
    }, undefined, capabilities);
    expect(entry.supported_reasoning_levels).toEqual([{ effort, description: '' }]);
    expect(entry.multi_agent_reasoning_effort).toBeUndefined();
  });

  describe('with a bundled base', () => {
    test('bundled input_modalities are preserved without inheriting image-detail support', () => {
      const entry = synthesizeCatalogEntry(base, bundledBase);
      expect(entry.input_modalities).toEqual(['text', 'image']);
      expect(entry.supports_image_detail_original).toBe(false);
      expect(entry.web_search_tool_type).toBe('text_and_image');
    });

    test.each(['v1', 'v2'])('preserves the explicit Ultra mapping for multi-agent %s', multiAgentVersion => {
      const entry = synthesizeCatalogEntry(base, {
        ...bundledBase,
        supported_reasoning_levels: [
          { effort: 'xhigh', description: 'Extra high' },
          { effort: 'max', description: 'Maximum' },
          { effort: 'ultra', description: 'Existing Ultra' },
        ],
        multi_agent_version: multiAgentVersion,
        multi_agent_reasoning_effort: 'xhigh',
      });
      expect(entry.supported_reasoning_levels).toEqual([
        { effort: 'xhigh', description: 'Extra high' },
        { effort: 'max', description: 'Maximum' },
        { effort: 'ultra', description: 'Existing Ultra' },
      ]);
      expect(entry.multi_agent_version).toBe(multiAgentVersion);
      expect(entry.multi_agent_reasoning_effort).toBe('xhigh');
    });

    test('maps Ultra to the last non-Ultra effort, wherever Ultra sits', () => {
      const supportedReasoning = ['high', 'ultra', 'vendor-specific'].map(effort => ({ effort, description: effort }));
      const entry = synthesizeCatalogEntry(base, {
        ...bundledBase,
        supported_reasoning_levels: supportedReasoning,
        default_reasoning_level: 'none',
        multi_agent_version: 'v2',
      });
      expect(entry.multi_agent_reasoning_effort).toBe('vendor-specific');
      expect(entry.supported_reasoning_levels).toEqual(supportedReasoning);
    });

    test('adds Ultra from registry-overlaid presets while retaining a valid catalog mapping', () => {
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
      expect(entry.supported_reasoning_levels).toEqual([
        { effort: 'xhigh', description: '' },
        ultraCapabilities.ultraReasoningLevel,
      ]);
      expect(entry.default_reasoning_level).toBe('xhigh');
      expect(entry.multi_agent_reasoning_effort).toBe('xhigh');
    });
  });
});
