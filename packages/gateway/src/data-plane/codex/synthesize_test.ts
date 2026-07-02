import { describe, expect, test } from 'vitest';

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
    // Codex's ModelInfo struct (codex-rs/protocol/src/openai_models.rs) makes
    // these two mandatory at the wire level — absent fields abort
    // deserialization and codex silently falls back to its bundled catalog.
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
    // Test the opening line so a future refresh that mangles the file gets
    // caught without re-asserting all ~20KB on every run.
    expect(typeof entry.base_instructions).toBe('string');
    expect((entry.base_instructions as string).startsWith('You are Codex, a coding agent running in the Codex CLI.')).toBe(true);
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

  test('service_tiers derived from cost.tiers keys', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      cost: { tiers: { fast: { input: 1 } } },
    });
    expect(entry.service_tiers).toEqual([{ id: 'fast', name: 'fast', description: '' }]);
  });

  test('service_tiers empty when no cost.tiers', () => {
    const entry = synthesizeCatalogEntry(base);
    expect(entry.service_tiers).toEqual([]);
  });

  test('service_tiers preserves key order for multiple tiers', () => {
    const entry = synthesizeCatalogEntry({
      ...base,
      cost: { tiers: { flex: { input: 1 }, priority: { input: 2 } } },
    });
    expect(entry.service_tiers).toEqual([
      { id: 'flex', name: 'flex', description: '' },
      { id: 'priority', name: 'priority', description: '' },
    ]);
  });
});
