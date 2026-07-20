import { describe, expect, test } from 'vitest';

import type { CatalogModel, CodexCatalogCapabilities } from './catalog.ts';
import { synthesizeCatalogEntry } from './synthesize.ts';
import type { InternalModel } from '@floway-dev/provider';

const base: InternalModel = {
  id: 'deepseek-v4-pro',
  display_name: 'DeepSeek V4 Pro',
  kind: 'chat',
  limits: { max_context_window_tokens: 128000 },
  endpoints: { chatCompletions: {} },
  providerModels: {},
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
    expect(entry.prefer_websockets).toBe(true);
    expect(entry.supports_parallel_tool_calls).toBe(true);
    expect(entry.supports_reasoning_summaries).toBe(false);
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
  });

  test('base_instructions collapses to a single identity sentence when display_name equals id', () => {
    const entry = synthesizeCatalogEntry({ ...base, display_name: undefined });
    // With no display_name, id falls through to both slots; the paragraph
    // states the model once instead of the "named X. Exact ID is X."
    // redundancy.
    expect(entry.base_instructions as string).toContain('You are powered by the model "deepseek-v4-pro".');
    expect(entry.base_instructions as string).not.toContain('The exact model ID is');
  });

  test('falls back to id for display_name when absent', () => {
    expect(synthesizeCatalogEntry({ ...base, display_name: undefined }).display_name).toBe('deepseek-v4-pro');
  });

  test('defaults context_window to 128k when registry omits max_context_window_tokens', () => {
    // Without a value here, codex's `(cw * 9) / 10` auto-compact trigger
    // would divide against an absent/zero window. The conservative default
    // gives every synthesized entry a safe, low ceiling that an operator
    // can raise by filling in the registry.
    const entry = synthesizeCatalogEntry({ ...base, limits: {} });
    expect(entry.context_window).toBe(128_000);
    expect(entry.max_context_window).toBe(128_000);
  });

  test('derives image-aware web_search when modalities include image', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { modalities: { input: ['text', 'image'], output: ['text'] } },
    });
    expect(entry.input_modalities).toEqual(['text', 'image']);
    expect(entry.web_search_tool_type).toBe('text_and_image');
    expect(entry.supports_image_detail_original).toBe(true);
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.default_reasoning_level).toBeUndefined();
  });

  test('propagates reasoning levels as {effort, description} preset', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { effort: { supported: ['low', 'high'], default: 'low' } } },
    });
    expect(entry.supported_reasoning_levels).toEqual([
      { effort: 'low', description: '' },
      { effort: 'high', description: '' },
    ]);
    expect(entry.default_reasoning_level).toBe('low');
  });

  test('does not infer Ultra support from Max alone', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { effort: { supported: ['low', 'max'], default: 'low' } } },
    });
    expect(entry.supported_reasoning_levels).toEqual([
      { effort: 'low', description: '' },
      { effort: 'max', description: '' },
    ]);
    expect(entry.multi_agent_version).toBeUndefined();
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
  });

  test('drops budget_tokens silently — no effort fields on output', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { budget_tokens: { min: 100, max: 8000 } } },
    });
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.default_reasoning_level).toBeUndefined();
  });

  test('drops adaptive silently — no effort fields on output', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { adaptive: true } },
    });
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.default_reasoning_level).toBeUndefined();
  });

  test('drops mandatory silently — no effort fields on output', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { mandatory: true } },
    });
    expect(entry.supported_reasoning_levels).toEqual([]);
    expect(entry.default_reasoning_level).toBeUndefined();
  });

  test('effort wins when combined with adaptive — adaptive dropped', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      chat: { reasoning: { effort: { supported: ['medium'], default: 'medium' }, adaptive: true } },
    });
    expect(entry.supported_reasoning_levels).toEqual([{ effort: 'medium', description: '' }]);
    expect(entry.default_reasoning_level).toBe('medium');
  });

  test('service_tiers derived from pricing.entries keys', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      pricing: { entries: [{ rates: { input: 1 } }, { selector: { serviceTier: 'fast' }, rates: { input: 1 } }] },
    });
    expect(entry.service_tiers).toEqual([{ id: 'fast', name: 'fast', description: '' }]);
  });

  test('service_tiers empty when no pricing.entries', () => {
    const entry = synthesizeCatalogEntry(base);
    expect(entry.service_tiers).toEqual([]);
  });

  test('service_tiers preserves key order for multiple tiers', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      pricing: { entries: [{ rates: { input: 1 } }, { selector: { serviceTier: 'flex' }, rates: { input: 1 } }, { selector: { serviceTier: 'priority' }, rates: { input: 2 } }] },
    });
    expect(entry.service_tiers).toEqual([
      { id: 'flex', name: 'flex', description: '' },
      { id: 'priority', name: 'priority', description: '' },
    ]);
  });

  describe('with a bundled base', () => {
    // A realistic bundled entry — richer than the miss-path BASELINE and
    // used as `source` when the caller matched the registry model against
    // the codex bundled catalog.
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
      service_tiers: [{ id: 'priority', name: 'priority', description: '' }],
      base_instructions: 'BUNDLED PROMPT',
      truncation_policy: { mode: 'tokens', limit: 20000 },
    };

    test('slug always overrides to model.id (bundled base carries the upstream slug)', () => {
      const entry = synthesizeCatalogEntry({ ...base, id: 'openrouter/gpt-5.5:nitro' }, bundledBase);
      expect(entry.slug).toBe('openrouter/gpt-5.5:nitro');
    });

    test('display_name falls back to bundled when registry omits it', () => {
      const entry = synthesizeCatalogEntry({ ...base, display_name: undefined }, bundledBase);
      expect(entry.display_name).toBe('GPT-5.5');
    });

    test('unannounced fields ride through from bundled base unchanged', () => {
      const entry = synthesizeCatalogEntry(base, bundledBase);
      expect(entry.priority).toBe(1);
      expect(entry.visibility).toBe('list');
      expect(entry.base_instructions).toBe('BUNDLED PROMPT');
      expect(entry.truncation_policy).toEqual({ mode: 'tokens', limit: 20000 });
    });

    test('bundled input_modalities preserved when registry omits chat.modalities', () => {
      const entry = synthesizeCatalogEntry(base, bundledBase);
      expect(entry.input_modalities).toEqual(['text', 'image']);
      expect(entry.supports_image_detail_original).toBe(true);
      expect(entry.web_search_tool_type).toBe('text_and_image');
    });

    test('registry chat.modalities overrides bundled input_modalities and redrives image-support fields', () => {
      const entry = synthesizeCatalogEntry({
        ...base,
        chat: { modalities: { input: ['text'], output: ['text'] } },
      }, bundledBase);
      expect(entry.input_modalities).toEqual(['text']);
      expect(entry.supports_image_detail_original).toBe(false);
      expect(entry.web_search_tool_type).toBe('text');
    });

    test('bundled supported_reasoning_levels preserved when registry omits chat.reasoning', () => {
      const entry = synthesizeCatalogEntry(base, bundledBase);
      expect(entry.supported_reasoning_levels).toEqual([{ effort: 'medium', description: '' }]);
    });

    test('registry chat.reasoning.effort overrides bundled supported_reasoning_levels', () => {
      const entry = synthesizeCatalogEntry({
        ...base,
        chat: { reasoning: { effort: { supported: ['high'], default: 'high' } } },
      }, bundledBase);
      expect(entry.supported_reasoning_levels).toEqual([{ effort: 'high', description: '' }]);
      expect(entry.default_reasoning_level).toBe('high');
    });

    test('preserves an existing Ultra preset without duplication', () => {
      const entry = synthesizeCatalogEntry(base, {
        ...bundledBase,
        supported_reasoning_levels: [
          { effort: 'max', description: 'Maximum' },
          { effort: 'ultra', description: 'Existing Ultra' },
        ],
        multi_agent_version: 'v1',
      });
      expect(entry.supported_reasoning_levels).toEqual([
        { effort: 'max', description: 'Maximum' },
        { effort: 'ultra', description: 'Existing Ultra' },
      ]);
      expect(entry.multi_agent_version).toBe('v1');
    });

    test('bundled context_window preserved when registry omits max_context_window_tokens', () => {
      const entry = synthesizeCatalogEntry({ ...base, limits: {} }, bundledBase);
      expect(entry.context_window).toBe(272_000);
      expect(entry.max_context_window).toBe(272_000);
    });

    test('registry max_context_window_tokens overrides bundled context_window', () => {
      const entry = synthesizeCatalogEntry({
        ...base,
        limits: { max_context_window_tokens: 100_000 },
      }, bundledBase);
      expect(entry.context_window).toBe(100_000);
      expect(entry.max_context_window).toBe(100_000);
    });

    test('service_tiers is a hard override — bundled tiers do not survive when registry has none', () => {
      // Bundled entries may advertise OpenAI 1p tiers Floway cannot bill;
      // publishing them without registry-side unit prices would surface a
      // toggle we could not honor. Registry-derived tiers (from
      // model.pricing.entries) always win, even when the registry list is empty.
      const entry = synthesizeCatalogEntry(base, bundledBase);
      expect(entry.service_tiers).toEqual([]);
    });

    test('service_tiers picks up the registry-configured tiers', () => {
      const entry = synthesizeCatalogEntry({
        ...base,
        pricing: { entries: [{ rates: { input: 1 } }, { selector: { serviceTier: 'fast' }, rates: { input: 1 } }] },
      }, bundledBase);
      expect(entry.service_tiers).toEqual([{ id: 'fast', name: 'fast', description: '' }]);
    });
  });
});
