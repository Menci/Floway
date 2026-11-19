import { describe, expect, test } from 'vitest';

import { chatField, modelsField, pricingField } from '../src/model-config.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('pricingField rejects malformed entries and duplicate coordinates', () => {
  assertThrows(() => pricingField({ entries: [{ rates: { input_tokens: '1', ouput: 4 } }] }, 'pricing'), Error);
  assertThrows(() => pricingField({
    entries: [
      { rates: { input_tokens: '1' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '2' } },
      { selector: { serviceTier: 'priority' }, rates: { input_tokens: '3' } },
    ],
  }, 'pricing'), Error);
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
      .toThrow();
  });

  test.each(['audio', 'image'])('preserves %s-only input in manual configuration', modality => {
    const chat = { modalities: { input: [modality], output: ['text'] } };
    expect(chatField(chat, 'm.chat')).toEqual(chat);
  });

  test('rejects an empty input list', () => {
    expect(() => chatField({ modalities: { input: [], output: ['text'] } }, 'm.chat')).toThrow();
  });
});

describe('modelsField rerank targets', () => {
  test('requires an explicit target for a rerank model', () => {
    expect(() => modelsField([{
      upstreamModelId: 'reranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
    }], 'p')).toThrow();
  });

  test('validates targets against the endpoint-derived runtime kind', () => {
    expect(() => modelsField([{
      upstreamModelId: 'chat',
      kind: 'chat',
      endpoints: { openaiChatCompletions: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }], 'p')).toThrow();
    expect(() => modelsField([{
      upstreamModelId: 'reranker',
      kind: 'rerank',
      endpoints: { openaiChatCompletions: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }], 'p')).toThrow();
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
