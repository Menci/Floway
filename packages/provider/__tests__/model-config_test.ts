import { describe, expect, test } from 'vitest';

import { chatField, modelsField, pricingField } from '../src/model-config.ts';
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
  // Unlike reasoning.adaptive / reasoning.mandatory, `false` here is the
  // upstream stating it rejects detail 'original', not the absence of a
  // statement.
  test('preserves image_detail_original: false rather than stripping it', () => {
    const chat = chatField({ image_detail_original: false }, 'm.chat');
    expect(chat).toEqual({ image_detail_original: false });
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

  test('rejects reasoning with only adaptive: false and mandatory: false', () => {
    expect(() => chatField({ reasoning: { adaptive: false, mandatory: false } }, 'm.chat'))
      .toThrow(/at least one of effort, budget_tokens, adaptive, mandatory/);
  });

  test.each([
    ['default not in supported', { supported: ['low', 'high'], default: 'medium' }, /effort\.default/],
    ['empty supported', { supported: [], default: '' }, /effort\.supported/],
  ])('rejects effort with %s', (_label, effort, message) => {
    expect(() => chatField({ reasoning: { effort } }, 'm.chat')).toThrow(message);
  });

  test('rejects budget_tokens with max < min', () => {
    expect(() => chatField({ reasoning: { budget_tokens: { min: 500, max: 100 } } }, 'm.chat')).toThrow(/max must be >= min/);
  });

  test('returns undefined when chat block is empty', () => {
    expect(chatField({}, 'm.chat')).toBeUndefined();
  });

  test('rejects modalities missing text', () => {
    expect(() => chatField({ modalities: { input: ['image'], output: ['text'] } }, 'm.chat'))
      .toThrow(/must include 'text'/);
  });

  test('deduplicates modality entries', () => {
    const chat = chatField({ modalities: { input: ['text', 'text', 'image'], output: ['text'] } }, 'm.chat');
    expect(chat?.modalities?.input).toEqual(['text', 'image']);
  });
});

describe('modelsField metadata integration', () => {
  test('keeps an explicit stored kind round-trippable when transcription endpoints disagree', () => {
    const [model] = modelsField([{
      upstreamModelId: 'transcriber',
      kind: 'chat',
      endpoints: { openaiAudioTranscriptions: {} },
    }], 'p');
    expect(model.kind).toBe('chat');
    expect(model.endpoints).toEqual({ openaiAudioTranscriptions: {} });
  });

  test('rejects chat on non-chat kind', () => {
    expect(() => modelsField([{
      upstreamModelId: 'm',
      kind: 'embedding',
      endpoints: { openaiEmbeddings: {} },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    }], 'p')).toThrow(/chat .* only allowed when kind/);
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
      endpoints: { openaiChatCompletions: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }], 'p')).toThrow(/rerankTarget is only allowed/);
    expect(() => modelsField([{
      upstreamModelId: 'reranker',
      kind: 'rerank',
      endpoints: { openaiChatCompletions: {} },
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

describe('modelsField decision targets', () => {
  test('accepts a supported protocol and path', () => {
    const [model] = modelsField([{
      upstreamModelId: 'decision-1',
      kind: 'decision',
      endpoints: { decision: {} },
      decisionTarget: { protocol: 'typesafe-systemone', path: ' /providers/microsoft/v1/systemone ' },
    }], 'p');
    expect(model.decisionTarget).toEqual({ protocol: 'typesafe-systemone', path: '/providers/microsoft/v1/systemone' });
  });

  test('rejects a decision target on a model that is not decision', () => {
    expect(() => modelsField([{
      upstreamModelId: 'chat',
      kind: 'chat',
      endpoints: { openaiChatCompletions: {} },
      decisionTarget: { protocol: 'typesafe-systemone' },
    }], 'p')).toThrow(/decisionTarget is only allowed/);
  });

  test('rejects an unknown protocol', () => {
    expect(() => modelsField([{
      upstreamModelId: 'decision-1',
      kind: 'decision',
      endpoints: { decision: {} },
      decisionTarget: { protocol: 'jev' },
    }], 'p')).toThrow(/unsupported decision protocol/);
  });
});

test('modelsField parses a full model entry', () => {
  const models = modelsField(
    [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-5',
        endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
        display_name: 'GPT Prod',
        limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
        pricing: { entries: [{ rates: { input_tokens: '2.5', output_tokens: '15', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.75' } }] },
        flagOverrides: { 'vendor-deepseek': false },
        opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'shared-model' },
      },
    ],
    'azure',
  );

  assertEquals(models, [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-5',
      kind: 'chat',
      endpoints: { openaiChatCompletions: {}, openaiResponses: {} },
      display_name: 'GPT Prod',
      limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
      pricing: { entries: [{ rates: { input_tokens: '2.5', output_tokens: '15', input_cache_read_tokens: '0.25', input_cache_write_tokens: '3.75' } }] },
      flagOverrides: { 'vendor-deepseek': false },
      opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'shared-model' },
    },
  ]);
});

test('modelsField rejects a missing upstreamModelId', () => {
  assertThrows(
    () => modelsField([{ endpoints: { openaiChatCompletions: {} } }], 'azure'),
    Error,
    'Malformed azure models[0].upstreamModelId: must be a non-empty string',
  );
});

test('modelsField rejects an empty endpoints object', () => {
  assertThrows(
    () => modelsField([{ upstreamModelId: 'gpt-prod', endpoints: {  } }], 'azure'),
    Error,
    'Malformed azure models[0].endpoints: must declare at least one endpoint',
  );
});

test('modelsField rejects an unsupported endpoint key', () => {
  assertThrows(
    () => modelsField([{ upstreamModelId: 'gpt-prod', endpoints: { bogus: {} } }], 'azure'),
    Error,
    'Malformed azure models[0].endpoints: unsupported endpoint bogus',
  );
});

test('modelsField derives kind from endpoints when omitted', () => {
  const [embedding] = modelsField([{ upstreamModelId: 'e', endpoints: { openaiEmbeddings: {} } }], 'custom');
  assertEquals(embedding.kind, 'embedding');
  const [image] = modelsField([{ upstreamModelId: 'i', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } }], 'custom');
  assertEquals(image.kind, 'image');
  const [audio] = modelsField([{ upstreamModelId: 'a', endpoints: { openaiAudioTranscriptions: {} } }], 'custom');
  assertEquals(audio.kind, 'transcription');
  const [chat] = modelsField([{ upstreamModelId: 'c', endpoints: { openaiResponses: {} } }], 'custom');
  assertEquals(chat.kind, 'chat');
});

test('modelsField rejects an unknown kind', () => {
  assertThrows(
    () => modelsField([{ upstreamModelId: 'm', kind: 'bogus', endpoints: { openaiChatCompletions: {} } }], 'custom'),
    Error,
    'Malformed custom models[0].kind: must be one of chat, embedding, image, rerank, transcription',
  );
});

test('modelsField rejects flagOverrides with an unknown flag id', () => {
  assertThrows(
    () =>
      modelsField(
        [
          {
            upstreamModelId: 'gpt-prod',
            endpoints: { openaiChatCompletions: {} },
            flagOverrides: { 'made-up-flag': true },
          },
        ],
        'azure',
      ),
    Error,
    'Malformed azure models[0].flagOverrides: unknown flag ids: made-up-flag',
  );
});
