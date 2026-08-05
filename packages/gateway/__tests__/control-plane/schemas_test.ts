import { describe, expect, test } from 'vitest';

import { authLoginBody, createAliasBody, createUpstreamBody, createUserBody } from '../../src/control-plane/schemas.ts';
import { MODEL_ALIAS_TARGET_LIMIT } from '../../src/shared/model-aliases.ts';

const baseAzure = {
  kind: 'azure' as const,
  name: 'azure',
  hue: 210,
  config: {
    endpoint: 'https://a.example.com',
    apiKey: 'k',
    models: [{
      upstreamModelId: 'm',
      kind: 'chat' as const,
      endpoints: { chatCompletions: {} },
    }],
  },
};

describe('upstreamModelSchema chat', () => {
  test('accepts an audio transcription model', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    model.kind = 'transcription';
    model.endpoints = { audioTranscriptions: {} };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('accepts a valid chat block with effort', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'medium'], default: 'low' } },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('accepts chat metadata when chat endpoints derive an omitted kind', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    delete model.kind;
    model.chat = { modalities: { input: ['text'], output: ['text'] } };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('accepts chat metadata when any chat endpoint accompanies a stale non-chat primary kind', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    model.kind = 'embedding';
    model.endpoints = { embeddings: {}, chatCompletions: {} };
    model.chat = { modalities: { input: ['text'], output: ['text'] } };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('accepts chat with budget_tokens only', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { budget_tokens: { min: 100, max: 5000 } },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('accepts chat with empty budget_tokens', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { budget_tokens: {} },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('accepts chat with adaptive: true', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { adaptive: true },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('accepts chat with mandatory: true', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { mandatory: true },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('rejects reasoning with adaptive: false', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { adaptive: false },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects reasoning with adaptive: false even alongside mandatory: true', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { adaptive: false, mandatory: true },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects empty reasoning (no sub-block)', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: {},
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects chat on non-chat kind', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    model.kind = 'embedding';
    model.endpoints = { embeddings: {} };
    model.chat = { modalities: { input: ['text'], output: ['text'] } };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects chat metadata when omitted kind derives a non-chat kind', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    delete model.kind;
    model.endpoints = { embeddings: {} };
    model.chat = { modalities: { input: ['text'], output: ['text'] } };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects chat metadata when explicit chat kind conflicts with non-chat endpoints', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    model.kind = 'chat';
    model.endpoints = { embeddings: {} };
    model.chat = { modalities: { input: ['text'], output: ['text'] } };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects effort.default not in effort.supported', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { effort: { supported: ['low', 'high'], default: 'medium' } },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects budget_tokens.max < budget_tokens.min', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      reasoning: { budget_tokens: { min: 500, max: 100 } },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('accepts output modalities without text', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text'], output: ['image'] },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('rejects empty output modalities array', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text'], output: [] },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });
});

describe('upstreamModelSchema rerank', () => {
  const customRerank = () => ({
    kind: 'custom' as const,
    name: 'rerank',
    hue: 210,
    config: {
      baseUrl: 'https://rerank.example.com',
      authStyle: 'bearer' as const,
      ingressHeadersRules: [],
      apiKey: 'key',
      endpoints: {},
      models: [{
        upstreamModelId: 'reranker',
        kind: 'rerank' as const,
        endpoints: { rerank: {} },
        rerankTarget: { protocol: 'cohere-v2' as const },
      }],
    },
  });

  test('accepts an explicit target on a custom model', () => {
    expect(createUpstreamBody.safeParse(customRerank()).success).toBe(true);
  });

  test('derives rerank from its sole endpoint before validating the target', () => {
    const body = customRerank();
    delete (body.config.models[0] as Partial<typeof body.config.models[0]>).kind;
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test('rejects a rerank model without its target', () => {
    const body = customRerank();
    delete (body.config.models[0] as Partial<typeof body.config.models[0]>).rerankTarget;
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('rejects rerank models on Azure', () => {
    const body = structuredClone(baseAzure);
    const model = body.config.models[0] as Record<string, unknown>;
    model.kind = 'rerank';
    model.endpoints = { rerank: {} };
    model.rerankTarget = { protocol: 'cohere-v2' };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('treats explicit kind conflicts like existing image endpoint conflicts', () => {
    const chat = customRerank();
    (chat.config.models[0] as Record<string, unknown>).kind = 'chat';
    expect(createUpstreamBody.safeParse(chat).success).toBe(true);

    const mixed = customRerank();
    (mixed.config.models[0] as Record<string, unknown>).endpoints = { rerank: {}, chatCompletions: {} };
    expect(createUpstreamBody.safeParse(mixed).success).toBe(true);
  });
});

describe('model alias resource limits', () => {
  const bodyWithTargets = (count: number) => ({
    name: 'bounded-alias',
    kind: 'chat' as const,
    selection: 'first-available' as const,
    display_name: null,
    visible_in_models_list: true,
    targets: Array.from({ length: count }, (_, index) => ({ target_model_id: `model-${index}`, rules: {} })),
    announced_metadata: null,
  });

  test('accepts the target limit and rejects one additional candidate', () => {
    expect(createAliasBody.safeParse(bodyWithTargets(MODEL_ALIAS_TARGET_LIMIT)).success).toBe(true);
    expect(createAliasBody.safeParse(bodyWithTargets(MODEL_ALIAS_TARGET_LIMIT + 1)).success).toBe(false);
  });
});

describe('account password schemas', () => {
  test.each([
    ['1024 ASCII bytes', 'a'.repeat(1024)],
    ['1024 multibyte UTF-8 bytes', 'é'.repeat(512)],
  ])('accept %s', (_label, password) => {
    expect(authLoginBody.safeParse({ username: 'alice', password }).success).toBe(true);
    expect(createUserBody.safeParse({ username: 'alice', password }).success).toBe(true);
  });

  test.each([
    ['1025 ASCII bytes', 'a'.repeat(1025)],
    ['1026 multibyte UTF-8 bytes', 'é'.repeat(513)],
  ])('reject %s', (_label, password) => {
    expect(authLoginBody.safeParse({ username: 'alice', password }).success).toBe(false);
    expect(createUserBody.safeParse({ username: 'alice', password }).success).toBe(false);
  });

  test('allows the empty ADMIN_KEY login password but rejects an empty account password', () => {
    expect(authLoginBody.safeParse({ username: '', password: '' }).success).toBe(true);
    expect(createUserBody.safeParse({ username: 'alice', password: '' }).success).toBe(false);
  });
});
