import { describe, expect, test } from 'vitest';

import { isPiUserAgent, toPiCatalog } from '../../../src/data-plane/pi/catalog.ts';
import type { PublicModel } from '@floway-dev/protocols/common';

const model = (overrides: Partial<PublicModel> = {}): PublicModel => ({
  id: 'model',
  object: 'model',
  type: 'model',
  display_name: 'Model',
  kind: 'chat',
  limits: { max_context_window_tokens: 200000, max_output_tokens: 32000 },
  endpoints: { openaiResponses: {} },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  ...overrides,
});

const catalogModel = (overrides: Partial<PublicModel> = {}) => toPiCatalog([model(overrides)], 'https://gateway.example/v1').models[0]!;

describe('Pi model catalog', () => {
  test('recognizes both official Pi User-Agent forms without changing other clients', () => {
    expect(isPiUserAgent('pi/1.1.0 (darwin; node/v22.19.0; arm64)')).toBe(true);
    expect(isPiUserAgent('pi (linux 6.1; x64)')).toBe(true);
    for (const value of ['pi-models-discovery/1', 'omp/1', 'openai/1', undefined]) expect(isPiUserAgent(value)).toBe(false);
  });

  test('preserves model identity, vision and known token limits in an independent provider', () => {
    const mapped = catalogModel({ chat: { modalities: { input: ['text', 'image'], output: ['text'] } } });
    expect(mapped).toMatchObject({ provider: 'floway', api: 'openai-responses', baseUrl: 'https://gateway.example/v1', contextWindow: 200000, maxTokens: 32000, input: ['text', 'image'], reasoning: false });
    expect(toPiCatalog([model({ kind: 'embedding' })], 'https://gateway.example/v1').models).toEqual([]);
  });

  test('publishes only advertised named efforts and hides mandatory reasoning off', () => {
    const mapped = catalogModel({ chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' }, mandatory: true } } });
    expect(mapped.thinkingLevelMap).toEqual({ off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null });
    expect(mapped.reasoning).toBe(true);
    const disabled = catalogModel({ chat: { reasoning: { effort: { supported: ['none', 'high', 'max'], default: 'high' } } } });
    expect(disabled.thinkingLevelMap.off).toBe('none');
    expect(disabled.thinkingLevelMap.max).toBe('max');
  });

  test('maps open-string efforts into free native slots without losing declared defaults', () => {
    const mapped = catalogModel({ chat: { reasoning: { effort: { supported: ['fast', 'balanced', 'deep'], default: 'balanced' } } } });
    expect(mapped.thinkingLevelMap.low).toBe('fast');
    expect(mapped.thinkingLevelMap.medium).toBe('balanced');
    expect(mapped.thinkingLevelMap.high).toBe('deep');
    const collision = catalogModel({ chat: { reasoning: { effort: { supported: ['low', 'medium', 'custom'], default: 'custom' } } } });
    expect(collision.thinkingLevelMap.low).toBe('low');
    expect(collision.thinkingLevelMap.medium).toBe('medium');
    expect(collision.thinkingLevelMap.high).toBe('custom');
    expect(() => catalogModel({ chat: { reasoning: { effort: { supported: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], default: 'a' } } } })).toThrow('Pi cannot represent all reasoning efforts for model model');
  });

  test('selects native Anthropic for budget models and bounds every selectable budget', () => {
    const mapped = catalogModel({ chat: { reasoning: { budget_tokens: { min: 4096, max: 10000 } } } });
    expect(mapped.api).toBe('anthropic-messages');
    expect(mapped.thinkingBudgets).toEqual({ minimal: 4096, low: 4096, medium: 8192, high: 10000 });
    expect(mapped.thinkingLevelMap.off).toBe('off');
    const adaptive = catalogModel({ chat: { reasoning: { adaptive: true } } });
    expect(adaptive.api).toBe('anthropic-messages');
    expect(adaptive.compat).toEqual({ forceAdaptiveThinking: true });
    expect(adaptive.thinkingLevelMap).toEqual({ off: 'off', minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null });
    expect(adaptive.payloadRemovals).toEqual([['output_config', 'effort']]);
    const mandatory = catalogModel({ chat: { reasoning: { adaptive: true, mandatory: true } } });
    expect(mandatory.thinkingLevelMap.off).toBe(null);
  });

  test('rejects a budget that cannot fit the native answer ceiling', () => {
    expect(() => catalogModel({ limits: { max_output_tokens: 2048 }, chat: { reasoning: { budget_tokens: { min: 4096 } } } })).toThrow('Pi cannot fit the declared reasoning budget and answer tokens for model model');
    const mapped = catalogModel({ limits: { max_output_tokens: 10000 }, chat: { reasoning: { budget_tokens: { min: 1024 } } } });
    expect(mapped.thinkingBudgets?.high).toBe(8976);
  });

  test('mandatory reasoning without controls exposes no selectable effort or off switch', () => {
    const mapped = catalogModel({ chat: { reasoning: { mandatory: true } } });
    expect(mapped.reasoning).toBe(true);
    expect(Object.values(mapped.thinkingLevelMap)).toEqual([null, null, null, null, null, null, null]);
  });

  test('combined budget and named effort include exact server-derived request patches', () => {
    const mapped = catalogModel({ chat: { reasoning: { budget_tokens: { min: 4096, max: 10000 }, effort: { supported: ['fast', 'balanced', 'deep'], default: 'balanced' } } } });
    expect(mapped.api).toBe('anthropic-messages');
    expect(mapped.baseUrl).toBe('https://gateway.example');
    expect(mapped.payloadPatches).toEqual({ low: { output_config: { effort: 'fast' } }, medium: { output_config: { effort: 'balanced' } }, high: { output_config: { effort: 'deep' } } });
    expect(mapped.thinkingBudgets?.low).toBe(4096);
  });

  test('converts token prices and input-token thresholds without silently accepting invalid rates', () => {
    const rates = { input_tokens: '0.000003', output_tokens: '0.000015', input_cache_read_tokens: '0.0000003', input_cache_write_tokens: '0.00000375' };
    const mapped = catalogModel({
      pricing: {
        entries: [
          { rates },
          { selector: { inputTokens: { operator: 'gt', value: 200000 } }, rates: { ...rates, input_tokens: '0.000006' } },
          { selector: { inputTokens: { operator: 'gte', value: 300000 } }, rates: { ...rates, input_tokens: '0.000009' } },
          { selector: { serviceTier: 'priority' }, rates: { ...rates, input_tokens: '0.000012' } },
        ],
      },
    });
    expect(mapped.cost).toEqual({
      input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, tiers: [
        { input: 6, output: 15, cacheRead: 0.3, cacheWrite: 3.75, inputTokensAbove: 200000 },
        { input: 9, output: 15, cacheRead: 0.3, cacheWrite: 3.75, inputTokensAbove: 299999 },
      ],
    });
    expect(() => catalogModel({ pricing: { entries: [{ rates: { input_tokens: 'invalid' } }] } })).toThrow('Invalid model token price');
  });
});

test('projects an independent client provider identifier without changing public model IDs', () => {
  const named = toPiCatalog([model()], 'https://gateway.example/v1', 'personal').models[0]!;
  expect(named.provider).toBe('personal');
  expect(named.id).toBe('model');
});
