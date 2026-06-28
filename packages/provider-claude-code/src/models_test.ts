import { describe, expect, test } from 'vitest';

import {
  aliasFromApiId,
  buildClaudeCodeCatalog,
  chatFromCapabilities,
  type ClaudeCodeApiModel,
} from './models.ts';
import { pricingForClaudeCodeModelKey } from './pricing.ts';
import type { ClaudeCodeProviderData } from './types.ts';

const SAMPLE_API_MODELS: ClaudeCodeApiModel[] = [
  { id: 'claude-fable-5', display_name: 'Claude Fable 5', max_input_tokens: 1_000_000 },
  { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', max_input_tokens: 1_000_000 },
  { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1_000_000 },
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', max_input_tokens: 1_000_000 },
  { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200_000 },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', max_input_tokens: 200_000 },
];

describe('aliasFromApiId', () => {
  test('strips an 8-digit date suffix when present', () => {
    expect(aliasFromApiId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(aliasFromApiId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(aliasFromApiId('claude-opus-4-1-20250805')).toBe('claude-opus-4-1');
  });

  test('passes alias-shape ids through unchanged', () => {
    expect(aliasFromApiId('claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(aliasFromApiId('claude-fable-5')).toBe('claude-fable-5');
    expect(aliasFromApiId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });
});

describe('chatFromCapabilities', () => {
  // Case 1: effort.supported=false, thinking.types.enabled.supported=true only (mirrors Sonnet 4.5)
  test('effort disabled + enabled thinking → only budget_tokens in reasoning', () => {
    const chat = chatFromCapabilities({
      effort: { supported: false },
      thinking: { types: { enabled: { supported: true } } },
    });
    expect(chat).toEqual({ reasoning: { budget_tokens: {} } });
  });

  // Case 2: effort with 4 levels + xhigh=false + max=true, both thinking types (mirrors Opus 4.6)
  test('effort with low/medium/high/max + both thinking types → full reasoning', () => {
    const chat = chatFromCapabilities({
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: false },
        max: { supported: true },
      },
      thinking: { types: { enabled: { supported: true }, adaptive: { supported: true } } },
    });
    expect(chat).toEqual({
      reasoning: {
        effort: { supported: ['low', 'medium', 'high', 'max'], default: 'medium' },
        budget_tokens: {},
        adaptive: true,
      },
    });
  });

  // Case 3: effort with all 5 levels true, only adaptive thinking (mirrors Opus 4.7)
  test('effort with low/medium/high/xhigh/max + only adaptive thinking → effort + adaptive', () => {
    const chat = chatFromCapabilities({
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: true },
        max: { supported: true },
      },
      thinking: { types: { adaptive: { supported: true } } },
    });
    expect(chat).toEqual({
      reasoning: {
        effort: { supported: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
        adaptive: true,
      },
    });
  });

  // Case 4: no image_input → no modalities
  test('no image_input → no modalities key', () => {
    const chat = chatFromCapabilities({ effort: { supported: false } });
    expect(chat).toBeUndefined();
  });

  // Case 5: image_input + effort + enabled + adaptive → full chat object
  test('image_input=true + effort + both thinking types → full chat', () => {
    const chat = chatFromCapabilities({
      image_input: { supported: true },
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
      },
      thinking: { types: { enabled: { supported: true }, adaptive: { supported: true } } },
    });
    expect(chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: {
        effort: { supported: ['low', 'medium', 'high'], default: 'medium' },
        budget_tokens: {},
        adaptive: true,
      },
    });
  });

  // Case 6: no capabilities field → no chat key
  test('undefined capabilities → undefined', () => {
    expect(chatFromCapabilities(undefined)).toBeUndefined();
  });

  // Case 7: image_input.supported = false → no modalities
  test('image_input.supported=false → no modalities', () => {
    const chat = chatFromCapabilities({
      image_input: { supported: false },
      thinking: { types: { enabled: { supported: true } } },
    });
    expect(chat).toEqual({ reasoning: { budget_tokens: {} } });
  });

  // Case 8: default selection — 'medium' preferred; fallback to first
  test('effort default: medium when in supported list', () => {
    const chat = chatFromCapabilities({
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
      },
      thinking: { types: { enabled: { supported: true } } },
    });
    expect(chat!.reasoning!.effort!.default).toBe('medium');
  });

  test('effort default: first item when medium is not supported', () => {
    const chat = chatFromCapabilities({
      effort: {
        supported: true,
        low: { supported: true },
        high: { supported: true },
      },
      thinking: { types: { enabled: { supported: true } } },
    });
    expect(chat!.reasoning!.effort!.default).toBe('low');
  });
});

describe('buildClaudeCodeCatalog', () => {
  const models = buildClaudeCodeCatalog(SAMPLE_API_MODELS, new Set<string>());

  test('publishes each model under its public alias (date-stripped where applicable)', () => {
    expect(models.map(m => m.id)).toEqual([
      'claude-fable-5',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
    ]);
  });

  test('preserves the original upstream id under providerData.upstreamModelId', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect((byAlias.get('claude-sonnet-4-5')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-sonnet-4-5-20250929');
    expect((byAlias.get('claude-opus-4-7')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-opus-4-7');
    expect((byAlias.get('claude-fable-5')!.providerData as ClaudeCodeProviderData).upstreamModelId)
      .toBe('claude-fable-5');
  });

  test('every model advertises only the messages endpoint and chat kind', () => {
    for (const m of models) {
      expect(m.endpoints).toEqual({ messages: {} });
      expect(m.kind).toBe('chat');
      expect(m.owned_by).toBe('anthropic');
    }
  });

  test('carries display_name and context window from the api response', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect(byAlias.get('claude-fable-5')!.display_name).toBe('Claude Fable 5');
    expect(byAlias.get('claude-fable-5')!.limits.max_context_window_tokens).toBe(1_000_000);
    expect(byAlias.get('claude-haiku-4-5')!.limits.max_context_window_tokens).toBe(200_000);
  });

  test('wires pricing through pricingForClaudeCodeModelKey keyed by the upstream id', () => {
    const byAlias = new Map(models.map(m => [m.id, m]));
    expect(byAlias.get('claude-opus-4-7')!.cost).toEqual(pricingForClaudeCodeModelKey('claude-opus-4-7'));
    expect(byAlias.get('claude-sonnet-4-5')!.cost).toEqual(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929'));
    expect(byAlias.get('claude-fable-5')!.cost).toEqual(pricingForClaudeCodeModelKey('claude-fable-5'));
  });

  test('forwards the supplied enabledFlags set onto every model', () => {
    const flags = new Set(['custom-flag-a', 'custom-flag-b']);
    const built = buildClaudeCodeCatalog(SAMPLE_API_MODELS, flags);
    for (const m of built) {
      expect(m.enabledFlags).toBe(flags);
    }
  });

  test('populates chat from capabilities when present', () => {
    const withCaps: ClaudeCodeApiModel[] = [
      {
        id: 'claude-opus-4-6-20251201',
        display_name: 'Claude Opus 4.6',
        max_input_tokens: 200_000,
        capabilities: {
          image_input: { supported: true },
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            max: { supported: true },
          },
          thinking: { types: { enabled: { supported: true }, adaptive: { supported: true } } },
        },
      },
    ];
    const built = buildClaudeCodeCatalog(withCaps, new Set());
    expect(built[0]!.chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: {
        effort: { supported: ['low', 'medium', 'high', 'max'], default: 'medium' },
        budget_tokens: {},
        adaptive: true,
      },
    });
  });

  test('omits chat key when capabilities absent', () => {
    const built = buildClaudeCodeCatalog(SAMPLE_API_MODELS, new Set());
    for (const m of built) {
      expect(m.chat).toBeUndefined();
    }
  });
});
