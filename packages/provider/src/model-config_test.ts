import { describe, expect, test } from 'vitest';

import { chatField, modelsField, pricingField } from './model-config.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('pricingField parses explicit flat entries', () => {
  assertEquals(pricingField(undefined, 'pricing'), undefined);
  const value = {
    entries: [
      { rates: { input_tokens: '5', output_tokens: '25' } },
      { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input_tokens: '15', output_tokens: '75' } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 272000 } }, rates: { input_tokens: '30', output_tokens: '150' } },
    ],
  };
  assertEquals(pricingField(value, 'pricing'), {
    entries: [
      { rates: { input_tokens: '5', output_tokens: '25' } },
      { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input_tokens: '15', output_tokens: '75' } },
      { selector: { serviceTier: 'fast', inputTokens: { operator: 'gt', value: 272000 } }, rates: { input_tokens: '30', output_tokens: '150' } },
    ],
  });
});

test('pricingField rejects malformed entries and duplicate coordinates', () => {
  assertThrows(() => pricingField({}, 'pricing'), Error, 'non-empty array');
  assertThrows(() => pricingField({ entries: [{ rates: { input_tokens: '1' } }], fallback: true }, 'pricing'), Error, 'unknown fields: fallback');
  assertThrows(() => pricingField({ entries: [{ rates: {} }] }, 'pricing'), Error, 'at least one rate');
  assertThrows(() => pricingField({ entries: [{ selector: { serviceTier: '' }, rates: { input_tokens: '1' } }] }, 'pricing'), Error, 'non-empty string');
  assertThrows(() => pricingField({ entries: [{ selector: { inputTokens: { operator: 'gt', value: 1.5 } }, rates: { input_tokens: '1' } }] }, 'pricing'), Error, 'positive safe integer');
  assertThrows(() => pricingField({ entries: [{ rates: { input_tokens: '1', ouput: 4 } }] }, 'pricing'), Error, 'unknown metrics: ouput');
  assertThrows(() => pricingField({ entries: [{ rates: { input_tokens: '1' }, fallback: true }] }, 'pricing'), Error, 'unknown fields: fallback');
  assertThrows(() => pricingField({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '3' } },
    ],
  }, 'pricing'), Error, 'duplicate pricing entry selector');
  assertThrows(() => pricingField({ entries: [{ rates: { input_tokens: '-1' } }] }, 'pricing'), Error, 'non-negative');
  assertThrows(() => pricingField({ entries: [{ rates: { input_tokens: 1 } }] }, 'pricing'), Error, 'must be a decimal string');
});

describe('chatField', () => {
  test('returns undefined when value is undefined', () => {
    expect(chatField(undefined, 'm.chat')).toBeUndefined();
  });

  test('parses a full chat block with effort sub-block', () => {
    const chat = chatField({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
    }, 'm.chat');
    expect(chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
    });
  });

  test('parses reasoning with budget_tokens only', () => {
    const chat = chatField({ reasoning: { budget_tokens: { min: 100, max: 5000 } } }, 'm.chat');
    expect(chat?.reasoning).toEqual({ budget_tokens: { min: 100, max: 5000 } });
  });

  test('parses reasoning with empty budget_tokens (bounds unknown)', () => {
    const chat = chatField({ reasoning: { budget_tokens: {} } }, 'm.chat');
    expect(chat?.reasoning).toEqual({ budget_tokens: {} });
  });

  test('parses reasoning with adaptive: true', () => {
    const chat = chatField({ reasoning: { adaptive: true } }, 'm.chat');
    expect(chat?.reasoning).toEqual({ adaptive: true });
  });

  test('strips adaptive: false to absent', () => {
    const chat = chatField({ reasoning: { adaptive: false, mandatory: true } }, 'm.chat');
    expect(chat?.reasoning).toEqual({ mandatory: true });
    expect(chat?.reasoning?.adaptive).toBeUndefined();
  });

  test('parses reasoning with mandatory: true', () => {
    const chat = chatField({ reasoning: { mandatory: true } }, 'm.chat');
    expect(chat?.reasoning).toEqual({ mandatory: true });
  });

  test('strips mandatory: false to absent', () => {
    const chat = chatField({ reasoning: { mandatory: false, adaptive: true } }, 'm.chat');
    expect(chat?.reasoning).toEqual({ adaptive: true });
    expect(chat?.reasoning?.mandatory).toBeUndefined();
  });

  test('parses all four sub-blocks together', () => {
    const chat = chatField({
      reasoning: {
        effort: { supported: ['low', 'high'], default: 'low' },
        budget_tokens: { min: 0, max: 1000 },
        adaptive: true,
        mandatory: false,
      },
    }, 'm.chat');
    expect(chat?.reasoning).toEqual({
      effort: { supported: ['low', 'high'], default: 'low' },
      budget_tokens: { min: 0, max: 1000 },
      adaptive: true,
    });
  });

  test('rejects empty reasoning (no sub-block)', () => {
    expect(() => chatField({ reasoning: {} }, 'm.chat'))
      .toThrow(/at least one of effort, budget_tokens, adaptive, mandatory/);
  });

  test('rejects reasoning with only adaptive: false and mandatory: false', () => {
    expect(() => chatField({ reasoning: { adaptive: false, mandatory: false } }, 'm.chat'))
      .toThrow(/at least one of effort, budget_tokens, adaptive, mandatory/);
  });

  test('rejects non-boolean adaptive', () => {
    expect(() => chatField({ reasoning: { adaptive: 'yes' } }, 'm.chat'))
      .toThrow(/adaptive.*boolean/);
  });

  test('rejects non-boolean mandatory', () => {
    expect(() => chatField({ reasoning: { mandatory: 1 } }, 'm.chat'))
      .toThrow(/mandatory.*boolean/);
  });

  test('rejects effort.default not in effort.supported', () => {
    expect(() => chatField({ reasoning: { effort: { supported: ['low', 'high'], default: 'medium' } } }, 'm.chat'))
      .toThrow(/effort\.default/);
  });

  test('rejects empty effort.supported', () => {
    expect(() => chatField({ reasoning: { effort: { supported: [], default: '' } } }, 'm.chat'))
      .toThrow(/effort\.supported/);
  });

  test('rejects empty string in effort.supported', () => {
    expect(() => chatField({ reasoning: { effort: { supported: ['low', ''], default: 'low' } } }, 'm.chat'))
      .toThrow(/effort\.supported/);
  });

  test('deduplicates effort.supported entries', () => {
    const chat = chatField({ reasoning: { effort: { supported: ['low', 'low', 'high'], default: 'low' } } }, 'm.chat');
    expect(chat?.reasoning?.effort?.supported).toEqual(['low', 'high']);
  });

  test('rejects budget_tokens.max < budget_tokens.min', () => {
    expect(() => chatField({ reasoning: { budget_tokens: { min: 500, max: 100 } } }, 'm.chat'))
      .toThrow(/max must be >= min/);
  });

  test('rejects negative budget_tokens.min', () => {
    expect(() => chatField({ reasoning: { budget_tokens: { min: -1 } } }, 'm.chat'))
      .toThrow(/non-negative integer/);
  });

  test('rejects non-integer budget_tokens.max', () => {
    expect(() => chatField({ reasoning: { budget_tokens: { max: 1.5 } } }, 'm.chat'))
      .toThrow(/non-negative integer/);
  });

  test('rejects reasoning without effort.default', () => {
    expect(() => chatField({ reasoning: { effort: { supported: ['low'] } } }, 'm.chat'))
      .toThrow(/effort\.default/);
  });

  test('returns undefined when chat block is empty', () => {
    expect(chatField({}, 'm.chat')).toBeUndefined();
  });

  test('accepts image-only output modalities', () => {
    const chat = chatField({ modalities: { input: ['text'], output: ['image'] } }, 'm.chat');
    expect(chat?.modalities?.output).toEqual(['image']);
  });

  test('rejects unknown modality value', () => {
    expect(() => chatField({ modalities: { input: ['video'], output: ['text'] } }, 'm.chat'))
      .toThrow(/modalities\.input/);
  });

  test('rejects modalities missing text', () => {
    expect(() => chatField({ modalities: { input: ['image'], output: ['text'] } }, 'm.chat'))
      .toThrow(/must include 'text'/);
  });

  test('deduplicates modality entries', () => {
    const chat = chatField({ modalities: { input: ['text', 'text', 'image'], output: ['text'] } }, 'm.chat');
    expect(chat?.modalities?.input).toEqual(['text', 'image']);
  });

  test('rejects empty output modalities array', () => {
    expect(() => chatField({ modalities: { input: ['text'], output: [] } }, 'm.chat'))
      .toThrow(/at least one modality/);
  });
});

describe('modelsField chat integration', () => {
  test('rejects chat on non-chat kind', () => {
    expect(() => modelsField([{
      upstreamModelId: 'm',
      kind: 'embedding',
      endpoints: { embeddings: {} },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    }], 'p')).toThrow(/chat .* only allowed when kind/);
  });

  test('accepts chat on chat kind', () => {
    const [m] = modelsField([{
      upstreamModelId: 'm',
      kind: 'chat',
      endpoints: { chatCompletions: {} },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    }], 'p');
    expect(m.chat?.modalities?.input).toEqual(['text']);
  });
});

describe('modelsField rerank targets', () => {
  test('requires an explicit target for a rerank model', () => {
    expect(() => modelsField([{
      upstreamModelId: 'reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
    }], 'p')).toThrow(/rerankTarget is required/);
  });

  test('accepts a supported protocol and normalized model-specific path', () => {
    const [model] = modelsField([{
      upstreamModelId: 'reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'dashscope-native', path: ' /custom/rerank ' },
    }], 'p');
    expect(model.rerankTarget).toEqual({ protocol: 'dashscope-native', path: '/custom/rerank' });
  });

  test('validates targets against the endpoint-derived runtime kind', () => {
    expect(() => modelsField([{
      upstreamModelId: 'chat',
      kind: 'chat',
      endpoints: { chatCompletions: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }], 'p')).toThrow(/rerankTarget is only allowed/);
    expect(() => modelsField([{
      upstreamModelId: 'reranker',
      kind: 'rerank',
      endpoints: { chatCompletions: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }], 'p')).toThrow(/rerankTarget is only allowed/);
  });

  test('accepts an explicit chat kind when endpoints select rerank', () => {
    const [model] = modelsField([{
      upstreamModelId: 'reranker',
      kind: 'chat',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }], 'p');
    expect(model.kind).toBe('chat');
    expect(model.rerankTarget).toEqual({ protocol: 'cohere-v2' });
  });
});
