import { describe, expect, it } from 'vitest';

import {
  isOmpSupportedKind,
  isOmpUserAgent,
  toOmpCatalog,
  toOmpPublicModel,
} from '../../../src/data-plane/models/omp-catalog.ts';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';

describe('isOmpUserAgent', () => {
  it('identifies floway-omp user agents with prefix floway-omp/', () => {
    expect(isOmpUserAgent('floway-omp/1')).toBe(true);
    expect(isOmpUserAgent('floway-omp/2')).toBe(true);
    expect(isOmpUserAgent('floway-omp/1.0.0')).toBe(true);
    expect(isOmpUserAgent('floway-omp/preview')).toBe(true);
  });

  it('rejects lookalike or non-omp user agents', () => {
    expect(isOmpUserAgent('not-floway-omp/1')).toBe(false);
    expect(isOmpUserAgent('floway-omp')).toBe(false);
    expect(isOmpUserAgent('floway-omp-other/1')).toBe(false);
    expect(isOmpUserAgent('claude-code/2.1.206')).toBe(false);
    expect(isOmpUserAgent('openai-python/1.42.0')).toBe(false);
    expect(isOmpUserAgent('')).toBe(false);
    expect(isOmpUserAgent(undefined)).toBe(false);
  });
});

describe('isOmpSupportedKind', () => {
  it('accepts chat, embedding, and image kinds', () => {
    expect(isOmpSupportedKind('chat')).toBe(true);
    expect(isOmpSupportedKind('embedding')).toBe(true);
    expect(isOmpSupportedKind('image')).toBe(true);
  });

  it('rejects non-chat / non-embedding / non-image kinds', () => {
    expect(isOmpSupportedKind('rerank')).toBe(false);
    expect(isOmpSupportedKind('transcription')).toBe(false);
  });
});

describe('toOmpPublicModel', () => {
  const baseModel: PublicModel = {
    id: 'test-model',
    object: 'model',
    type: 'model',
    display_name: 'Test Model',
    kind: 'chat',
    limits: {
      max_context_window_tokens: 128_000,
      max_prompt_tokens: 100_000,
      max_output_tokens: 16_384,
    },
    endpoints: {
      openaiChatCompletions: {},
      openaiResponses: {},
    },
    opaqueBlobCompatibilityScope: {
      bindToUpstream: true,
      key: 'test-model',
    },
    owned_by: 'test-provider',
    created: 1700000000,
    created_at: '2023-11-14T22:13:20.000Z',
    chat: {
      modalities: {
        input: ['text', 'image'],
        output: ['text'],
      },
    },
  };

  it('is additive only and preserves all original PublicModel fields', () => {
    const ompModel = toOmpPublicModel(baseModel);

    // Existing fields remain unchanged
    expect(ompModel.id).toBe(baseModel.id);
    expect(ompModel.object).toBe(baseModel.object);
    expect(ompModel.type).toBe(baseModel.type);
    expect(ompModel.display_name).toBe(baseModel.display_name);
    expect(ompModel.kind).toBe(baseModel.kind);
    expect(ompModel.endpoints).toBe(baseModel.endpoints);
    expect(ompModel.limits).toBe(baseModel.limits);
    expect(ompModel.opaqueBlobCompatibilityScope).toBe(baseModel.opaqueBlobCompatibilityScope);
    expect(ompModel.owned_by).toBe(baseModel.owned_by);
    expect(ompModel.created).toBe(baseModel.created);
    expect(ompModel.created_at).toBe(baseModel.created_at);
    expect(ompModel.chat).toBe(baseModel.chat);

    // limits remains intact without max_input_tokens injected
    expect(ompModel.limits.max_prompt_tokens).toBe(100_000);
    expect(ompModel.limits.max_output_tokens).toBe(16_384);
    expect((ompModel.limits as Record<string, unknown>).max_input_tokens).toBeUndefined();
  });

  it('sets context_length when limits.max_context_window_tokens is defined', () => {
    const ompModel = toOmpPublicModel({
      ...baseModel,
      limits: { max_context_window_tokens: 200_000 },
    });
    expect(ompModel.context_length).toBe(200_000);
  });

  it('omits context_length when limits.max_context_window_tokens is undefined', () => {
    const ompModel = toOmpPublicModel({
      ...baseModel,
      limits: { max_prompt_tokens: 100_000, max_output_tokens: 16_384 },
    });
    expect(ompModel.context_length).toBeUndefined();
    expect('context_length' in ompModel).toBe(false);
  });

  it('maps input_modalities from chat.modalities.input', () => {
    const ompModel = toOmpPublicModel({
      ...baseModel,
      chat: {
        modalities: {
          input: ['text', 'image'],
          output: ['text'],
        },
      },
    });
    expect(ompModel.input_modalities).toEqual(['text', 'image']);
  });

  it('lowercases input_modalities and passes through unknown names', () => {
    const ompModel = toOmpPublicModel({
      ...baseModel,
      chat: {
        modalities: {
          input: ['TEXT' as unknown as 'text', 'Audio' as unknown as 'text'],
          output: ['text'],
        },
      },
    });
    expect(ompModel.input_modalities).toEqual(['text', 'audio']);
  });

  it('omits input_modalities when chat or input modalities are absent', () => {
    const modelWithoutChat = toOmpPublicModel({
      ...baseModel,
      chat: undefined,
    });
    expect(modelWithoutChat.input_modalities).toBeUndefined();
    expect('input_modalities' in modelWithoutChat).toBe(false);

    const modelWithoutInputModalities = toOmpPublicModel({
      ...baseModel,
      chat: {},
    });
    expect(modelWithoutInputModalities.input_modalities).toBeUndefined();
    expect('input_modalities' in modelWithoutInputModalities).toBe(false);
  });

  it('assigns output_modalities ONLY for embedding and image kinds', () => {
    const chatModel = toOmpPublicModel({
      ...baseModel,
      kind: 'chat',
    });
    expect(chatModel.output_modalities).toBeUndefined();
    expect('output_modalities' in chatModel).toBe(false);

    const embeddingModel = toOmpPublicModel({
      ...baseModel,
      kind: 'embedding',
      endpoints: { openaiEmbeddings: {} },
    });
    expect(embeddingModel.output_modalities).toEqual(['embedding']);

    const imageModel = toOmpPublicModel({
      ...baseModel,
      kind: 'image',
      endpoints: { openaiImagesGenerations: {} },
    });
    expect(imageModel.output_modalities).toEqual(['image']);
  });
});

describe('toOmpCatalog', () => {
  const sampleCatalog: PublicModelsResponse = {
    object: 'list',
    has_more: false,
    first_id: 'chat-gpt',
    last_id: 'transcribe-whisper',
    data: [
      {
        id: 'chat-gpt',
        object: 'model',
        type: 'model',
        display_name: 'Chat GPT',
        kind: 'chat',
        limits: { max_context_window_tokens: 128_000, max_output_tokens: 4_096 },
        endpoints: { openaiChatCompletions: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
        chat: { modalities: { input: ['text'], output: ['text'] } },
      },
      {
        id: 'rerank-bge',
        object: 'model',
        type: 'model',
        display_name: 'Rerank BGE',
        kind: 'rerank',
        limits: { max_context_window_tokens: 8_192 },
        endpoints: { rerank: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
      },
      {
        id: 'embed-text',
        object: 'model',
        type: 'model',
        display_name: 'Embed Text',
        kind: 'embedding',
        limits: { max_context_window_tokens: 8_192 },
        endpoints: { openaiEmbeddings: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
      },
      {
        id: 'image-dall-e',
        object: 'model',
        type: 'model',
        display_name: 'DALL-E',
        kind: 'image',
        limits: {},
        endpoints: { openaiImagesGenerations: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
      },
      {
        id: 'transcribe-whisper',
        object: 'model',
        type: 'model',
        display_name: 'Whisper',
        kind: 'transcription',
        limits: {},
        endpoints: { openaiAudioTranscriptions: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
      },
      {
        id: 'alias-chat',
        object: 'model',
        type: 'model',
        display_name: 'Alias Chat',
        kind: 'chat',
        limits: { max_context_window_tokens: 200_000 },
        endpoints: { openaiChatCompletions: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
        aliasedFrom: {
          selection: 'random',
          targets: [{ target_model_id: 'chat-gpt', rules: {} }],
        },
      },
      {
        id: 'alias-rerank',
        object: 'model',
        type: 'model',
        display_name: 'Alias Rerank',
        kind: 'rerank',
        limits: {},
        endpoints: { rerank: {} },
        opaqueBlobCompatibilityScope: { bindToUpstream: true },
        aliasedFrom: {
          selection: 'random',
          targets: [{ target_model_id: 'rerank-bge', rules: {} }],
        },
      },
    ],
  };

  it('omits non-chat/non-embedding/non-image models including alias rows', () => {
    const result = toOmpCatalog(sampleCatalog);
    const resultIds = result.data.map(model => model.id);

    expect(resultIds).toEqual(['chat-gpt', 'embed-text', 'image-dall-e', 'alias-chat']);
    expect(resultIds).not.toContain('rerank-bge');
    expect(resultIds).not.toContain('transcribe-whisper');
    expect(resultIds).not.toContain('alias-rerank');
  });

  it('maintains list container invariants and updates first_id and last_id', () => {
    const result = toOmpCatalog(sampleCatalog);

    expect(result.object).toBe('list');
    expect(result.has_more).toBe(false);
    expect(result.first_id).toBe('chat-gpt');
    expect(result.last_id).toBe('alias-chat');
  });

  it('handles empty catalogs cleanly', () => {
    const emptyCatalog: PublicModelsResponse = {
      object: 'list',
      has_more: false,
      first_id: null,
      last_id: null,
      data: [],
    };
    const result = toOmpCatalog(emptyCatalog);

    expect(result.object).toBe('list');
    expect(result.has_more).toBe(false);
    expect(result.first_id).toBeNull();
    expect(result.last_id).toBeNull();
    expect(result.data).toEqual([]);
  });

  it('handles catalogs containing only omitted models', () => {
    const rerankOnlyCatalog: PublicModelsResponse = {
      object: 'list',
      has_more: false,
      first_id: 'rerank-bge',
      last_id: 'rerank-bge',
      data: [
        {
          id: 'rerank-bge',
          object: 'model',
          type: 'model',
          display_name: 'Rerank BGE',
          kind: 'rerank',
          limits: {},
          endpoints: { rerank: {} },
          opaqueBlobCompatibilityScope: { bindToUpstream: true },
        },
      ],
    };
    const result = toOmpCatalog(rerankOnlyCatalog);

    expect(result.first_id).toBeNull();
    expect(result.last_id).toBeNull();
    expect(result.data).toEqual([]);
  });
});
