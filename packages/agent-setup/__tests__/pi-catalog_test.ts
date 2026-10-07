import { describe, expect, test } from 'vitest';

import { toPiCatalog, toPiModel } from '../src/pi-catalog.ts';
import type { PublicModel } from '@floway-dev/protocols/common';

const baseModel = (id: string, overrides: Partial<PublicModel> = {}): PublicModel => ({
  id,
  object: 'model',
  type: 'model',
  display_name: `Display ${id}`,
  kind: 'chat',
  limits: {},
  endpoints: {},
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  ...overrides,
});

describe('toPiModel', () => {
  test('maps id and display_name into id and name', () => {
    const model = baseModel('gpt-4o', { display_name: 'GPT-4o (Omni)' });
    const pi = toPiModel(model);
    expect(pi.id).toBe('gpt-4o');
    expect(pi.name).toBe('GPT-4o (Omni)');
  });

  test('falls back to id when display_name is empty', () => {
    const model = baseModel('qwen-2.5', { display_name: '' });
    const pi = toPiModel(model);
    expect(pi.name).toBe('qwen-2.5');
  });

  test('maps reasoning = true when effort levels are advertised', () => {
    const model = baseModel('o1', {
      chat: { reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } } },
    });
    expect(toPiModel(model).reasoning).toBe(true);
  });

  test('maps reasoning = true when token budget is advertised', () => {
    const model = baseModel('claude-3-7-sonnet', {
      chat: { reasoning: { budget_tokens: { min: 1024, max: 64000 } } },
    });
    expect(toPiModel(model).reasoning).toBe(true);
  });

  test('maps reasoning = true when adaptive reasoning is advertised', () => {
    const model = baseModel('adaptive-model', {
      chat: { reasoning: { adaptive: true } },
    });
    expect(toPiModel(model).reasoning).toBe(true);
  });

  test('maps reasoning = true when mandatory reasoning is advertised', () => {
    const model = baseModel('mandatory-model', {
      chat: { reasoning: { mandatory: true } },
    });
    expect(toPiModel(model).reasoning).toBe(true);
  });

  test('omits reasoning when not advertised', () => {
    const model = baseModel('gpt-4o-mini', {
      chat: { reasoning: {} },
    });
    expect(toPiModel(model).reasoning).toBeUndefined();
  });

  test('maps input modalities restricted to text and image, defaulting to ["text"]', () => {
    const defaultModel = baseModel('text-only');
    expect(toPiModel(defaultModel).input).toEqual(['text']);

    const visionModel = baseModel('vision', {
      chat: { modalities: { input: ['text', 'image'], output: ['text'] } },
    });
    expect(toPiModel(visionModel).input).toEqual(['text', 'image']);

    // Non-text/non-image modalities are filtered out
    const strangeModalityModel = baseModel('strange', {
      chat: { modalities: { input: ['audio' as any, 'video' as any], output: ['text'] } },
    });
    expect(toPiModel(strangeModalityModel).input).toEqual(['text']);
  });

  test('maps contextWindow and maxTokens when limits are present and omits when undefined', () => {
    const withLimits = baseModel('with-limits', {
      limits: { max_context_window_tokens: 128000, max_output_tokens: 16384 },
    });
    const piLimits = toPiModel(withLimits);
    expect(piLimits.contextWindow).toBe(128000);
    expect(piLimits.maxTokens).toBe(16384);

    const noLimits = baseModel('no-limits');
    const piNoLimits = toPiModel(noLimits);
    expect(piNoLimits.contextWindow).toBeUndefined();
    expect(piNoLimits.maxTokens).toBeUndefined();
  });

  test('maps cost from pricing per million tokens when shape maps cleanly', () => {
    const model = baseModel('priced-model', {
      pricing: {
        entries: [
          {
            // Base entry: no selector
            rates: {
              input_tokens: '0.000003', // 3 USD / 1M tokens
              output_tokens: '0.000015', // 15 USD / 1M tokens
              input_cache_read_tokens: '0.0000003', // 0.3 USD / 1M tokens
              input_cache_write_tokens: '0.00000375', // 3.75 USD / 1M tokens
            },
          },
        ],
      },
    });
    const pi = toPiModel(model);
    expect(pi.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  test('defaults cost to zeros when pricing is absent or empty', () => {
    const model = baseModel('free-model');
    expect(toPiModel(model).cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test('does not carry any compat flags', () => {
    const model = baseModel('model');
    const pi = toPiModel(model) as any;
    expect(pi.compat).toBeUndefined();
  });
});

describe('toPiCatalog', () => {
  test('excludes non-chat models and stably sorts chat models by id', () => {
    const input: PublicModel[] = [
      baseModel('z-chat', { kind: 'chat' }),
      baseModel('b-embedding', { kind: 'embedding' }),
      baseModel('a-chat', { kind: 'chat' }),
      baseModel('c-image', { kind: 'image' }),
      baseModel('m-chat', { kind: 'chat' }),
      baseModel('r-rerank', { kind: 'rerank' as any }),
    ];

    const catalog = toPiCatalog(input);
    expect(catalog.models.map(m => m.id)).toEqual(['a-chat', 'm-chat', 'z-chat']);
  });

  test('returns empty models array on empty input', () => {
    expect(toPiCatalog([])).toEqual({ models: [] });
  });
});
