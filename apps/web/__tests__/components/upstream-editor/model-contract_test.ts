import { describe, expect, it } from 'vitest';

import { discoveredModelsFromResponse } from '../../../src/components/upstream-editor/data';
import { modelsAreValid } from '../../../src/components/upstream-editor/model-detail';
import type { UpstreamModelConfig } from '@floway-dev/provider';

describe('custom discovered model projection', () => {
  it('maps fixed kinds to their own endpoint families', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [
        { id: 'speech', kind: 'transcription' },
        { id: 'ranker', kind: 'rerank' },
      ],
    }, { chatCompletions: {} });

    expect(models[0]?.endpoints).toEqual({ audioTranscriptions: {} });
    expect(models[1]?.endpoints).toEqual({ rerank: {} });
  });

  it('gives a row that declares no kind the configured map the gateway gives it', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [{ id: 'bge-m3' }, { id: 'talker', kind: 'chat' }],
    }, { embeddings: {} });

    expect(models[0]?.endpoints).toEqual({ embeddings: {} });
    expect(models[1]?.endpoints).toEqual({ embeddings: {} });
  });

  it('withholds inherited rerank until an auto row becomes manual with a target', () => {
    const models = discoveredModelsFromResponse({
      kind: 'custom',
      data: [{ id: 'mixed' }, { id: 'talker', kind: 'chat' }],
    }, { embeddings: {}, rerank: {} });

    expect(models.map(model => model.endpoints)).toEqual([{ embeddings: {} }, { embeddings: {} }]);
    expect(models.every(model => model.rerankTarget === undefined)).toBe(true);
    expect(modelsAreValid(models)).toBe(true);
  });

  it('preserves chat metadata exactly when the configured endpoints resolve to chat', () => {
    const chat = {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'future'], default: 'future' } },
    } satisfies NonNullable<UpstreamModelConfig['chat']>;

    const chatModel = discoveredModelsFromResponse({ kind: 'custom', data: [{ id: 'vision', chat }] }, { responses: {} });
    const embeddingModel = discoveredModelsFromResponse({ kind: 'custom', data: [{ id: 'vision', chat }] }, { embeddings: {} });

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
    }, { chatCompletions: {} });

    expect(modelsAreValid(models)).toBe(true);
  });
});

describe('manual model validation', () => {
  it('rejects the same incomplete identities and endpoint contracts as the gateway', () => {
    expect(modelsAreValid([{ upstreamModelId: '', kind: 'chat', endpoints: { chatCompletions: {} } }])).toBe(false);
    expect(modelsAreValid([{ upstreamModelId: 'ranker', kind: 'rerank', endpoints: { rerank: {} } }])).toBe(false);
    expect(modelsAreValid([{
      upstreamModelId: 'ranker',
      kind: 'rerank',
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' },
    }])).toBe(true);
  });
});
