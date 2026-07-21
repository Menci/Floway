import { describe, expect, test } from 'vitest';

import { createUpstreamBody } from './schemas.ts';

const baseAzure = {
  kind: 'azure' as const,
  name: 'azure',
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
  test('accepts a valid chat block with effort', () => {
    const body = structuredClone(baseAzure);
    (body.config.models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'medium'], default: 'low' } },
    };
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
    config: {
      baseUrl: 'https://rerank.example.com',
      authStyle: 'bearer' as const,
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
