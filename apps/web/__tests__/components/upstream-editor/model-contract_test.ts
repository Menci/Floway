import { describe, expect, it } from 'vitest';

import { discoveredModelsFromResponse } from '../../../src/components/upstream-editor/data';
import { modelsAreValid } from '../../../src/components/upstream-editor/model-detail';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { projectCustomModels, type CustomModelsResponse } from '@floway-dev/provider-custom';

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

  it('matches provider projection for inferred, declared, and mixed endpoint families', () => {
    const endpoints = { chatCompletions: {}, embeddings: {}, imagesEdits: {}, rerank: {} };
    const chat = { reasoning: { effort: { supported: ['low'], default: 'low' } } };
    const response: CustomModelsResponse = {
      data: [
        { id: 'text-embedding-3-small' },
        { id: 'gpt-image-1' },
        { id: 'whisper-large-v3' },
        { id: 'declared-image', kind: 'image' },
        { id: 'declared-chat', kind: 'chat', chat },
        { id: 'unknown-model', chat },
      ],
    };
    const record: UpstreamRecord = {
      id: 'up_custom',
      kind: 'custom',
      name: 'Custom',
      enabled: true,
      sortOrder: 0,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      config: {
        baseUrl: 'https://custom.example.com',
        authStyle: 'none',
        endpoints,
        ingressHeadersRules: [],
        modelsFetch: { enabled: true },
        models: [],
      },
      state: null,
      flagOverrides: {},
      disabledPublicModelIds: [],
      proxyFallbackList: [],
      modelPrefix: null,
      modelsCache: null,
      hue: 210,
    };

    const providerModels = projectCustomModels(record, response).map(model => ({
      id: model.id,
      kind: model.kind,
      endpoints: model.endpoints,
      chat: model.chat,
    }));
    const dashboardModels = discoveredModelsFromResponse({ kind: 'custom', data: response.data }, endpoints)
      .map(model => ({
        id: model.upstreamModelId,
        kind: model.kind,
        endpoints: model.endpoints,
        chat: model.chat,
      }));

    expect(dashboardModels).toEqual(providerModels);
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
