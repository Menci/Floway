import { test } from 'vitest';

import { projectCustomDiscoveredModels } from '../src/catalog.ts';
import { inferEndpointsFromModelId } from '../src/infer-endpoints.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const OPENAI_EMBEDDINGS = { openaiEmbeddings: {} };
const OPENAI_IMAGES = { openaiImagesGenerations: {}, openaiImagesEdits: {} };
const OPENAI_AUDIO = { openaiAudioTranscriptions: {} };

test('inferEndpointsFromModelId returns OpenAI Embeddings for embedding family tokens', () => {
  assertEquals(inferEndpointsFromModelId('BAAI/bge-large-en'), OPENAI_EMBEDDINGS);
});

test('inferEndpointsFromModelId returns audio transcription for standard transcribe and whisper families', () => {
  for (const id of ['gpt-4o-mini-transcribe-2025-12-15', 'openai/whisper-large-v3']) {
    assertEquals(inferEndpointsFromModelId(id), OPENAI_AUDIO);
  }
});

test('Custom dashboard projection shares endpoint inference and preserves unroutable rerank rows', () => {
  const record: UpstreamRecord = {
    id: 'up_custom_preview',
    kind: 'custom',
    name: 'Custom Preview',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    config: {
      baseUrl: 'https://custom.example.com',
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  };
  const models = projectCustomDiscoveredModels(record, {
    data: [
      { id: 'gpt-image-2', opaqueBlobCompatibilityScope: { bindToUpstream: false, key: 'shared-images' } },
      { id: 'speech', kind: 'transcription' },
      { id: 'ranker', kind: 'rerank' },
      { id: 'embedding', kind: 'embedding', chat: { image_detail_original: true } },
    ],
  });
  assertEquals(models.map(model => ({ id: model.upstreamModelId, kind: model.kind, endpoints: model.endpoints })), [
    { id: 'gpt-image-2', kind: 'image', endpoints: OPENAI_IMAGES },
    { id: 'speech', kind: 'transcription', endpoints: OPENAI_AUDIO },
    { id: 'ranker', kind: 'rerank', endpoints: { rerank: {} } },
    { id: 'embedding', kind: 'embedding', endpoints: { openaiEmbeddings: {} } },
  ]);
  assertEquals(models[0].opaqueBlobCompatibilityScope, { bindToUpstream: false, key: 'shared-images' });
  assertEquals(models[1].opaqueBlobCompatibilityScope, { bindToUpstream: true });
  assertEquals(models[3].chat, undefined);
});
