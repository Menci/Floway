import { describe, expect, it } from 'vitest';

import { discoveredModelsFromResponse } from '../../../src/components/upstream-editor/data';
import { modelsAreValid } from '../../../src/components/upstream-editor/model-validation';
import type { UpstreamModelConfig } from '@floway-dev/provider/model-config';

describe('custom discovered model projection', () => {
  it('maps fixed kinds to their own endpoint families', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'speech', kind: 'transcription' },
        { id: 'ranker', kind: 'rerank' },
      ],
    }, { openaiChatCompletions: {} });

    expect(models[0]?.endpoints).toEqual({ openaiAudioTranscriptions: {} });
    expect(models[1]?.endpoints).toEqual({ rerank: {} });
  });

  it('gives a row that declares no kind the configured map the gateway gives it', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [{ id: 'bge-m3' }, { id: 'talker', kind: 'chat' }],
    }, { openaiEmbeddings: {} });

    expect(models[0]?.endpoints).toEqual({ openaiEmbeddings: {} });
    expect(models[1]?.endpoints).toEqual({ openaiEmbeddings: {} });
  });

  it('preserves chat metadata exactly when the configured endpoints resolve to chat', () => {
    const chat = {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['none', 'high'], default: 'high' } },
    } satisfies NonNullable<UpstreamModelConfig['chat']>;

    const chatModel = discoveredModelsFromResponse({ kind: 'custom', data: [{ id: 'vision', chat }] }, { openaiResponses: {} });
    const embeddingModel = discoveredModelsFromResponse({ kind: 'custom', data: [{ id: 'vision', chat }] }, { openaiEmbeddings: {} });

    expect(chatModel[0]?.chat).toEqual(chat);
    expect(embeddingModel[0]?.chat).toBeUndefined();
  });

  it('projects every discovered row into a shape the gateway accepts', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'talker', kind: 'chat' },
        { id: 'painter', kind: 'image' },
        { id: 'speech', kind: 'transcription' },
        { id: 'ranker', kind: 'rerank' },
      ],
    }, { openaiChatCompletions: {} });

    expect(modelsAreValid(models)).toBe(true);
  });
});

describe('manual model validation', () => {
  it('rejects the same incomplete identities and endpoint contracts as the gateway', () => {
    expect(modelsAreValid([{ upstreamModelId: '', kind: 'chat', endpoints: { openaiChatCompletions: {} } }])).toBe(false);
    expect(modelsAreValid([{ upstreamModelId: 'ranker', kind: 'rerank', endpoints: { rerank: {} } }])).toBe(false);
    expect(modelsAreValid([{
      upstreamModelId: 'ranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }])).toBe(true);
  });
});
