import { describe, expect, test } from 'vitest';

import { chatField, modelsField, pricingField } from '../src/model-config.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('pricingField rejects malformed entries and duplicate coordinates', () => {
  assertThrows(() => pricingField({ entries: [{ rates: { input_tokens: '1', ouput: 4 } }] }, 'pricing'), Error, 'unknown metrics: ouput');
  assertThrows(() => pricingField({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '3' } },
    ],
  }, 'pricing'), Error, 'duplicate pricing entry selector');
});

describe('chatField', () => {
  // Unlike reasoning.adaptive / reasoning.mandatory, `false` here is the
  // upstream stating it rejects detail 'original', not the absence of a
  // statement.
  test('preserves image_detail_original: false rather than stripping it', () => {
    const chat = chatField({ image_detail_original: false }, 'm.chat');
    expect(chat).toEqual({ image_detail_original: false });
  });

  test('rejects an effort default outside the supported list', () => {
    expect(() => chatField({ reasoning: { effort: { supported: ['low', 'high'], default: 'medium' } } }, 'm.chat'))
      .toThrow(/effort\.default/);
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
