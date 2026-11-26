import { describe, expect, test } from 'vitest';

import { chatgptImportExchangeBody, createAliasBody, createUpstreamBody } from '../../src/control-plane/schemas.ts';

const baseAzure = {
  kind: 'azure' as const,
  name: 'azure',
  hue: 210,
  config: {
    endpoint: 'https://a.example.com',
    apiKey: 'k',
  },
  manual_models: [{
    upstreamModelId: 'm',
    kind: 'chat' as const,
    endpoints: { openaiChatCompletions: {} },
  }],
};

describe('ChatGPT import schemas', () => {
  const record = { id: '', kind: 'chatgpt', config: { accounts: [] }, state: { accounts: [] } };

  test('accepts exactly one import source', () => {
    expect(chatgptImportExchangeBody.safeParse({ record, manual: { access_token: 'opaque' } }).success).toBe(true);
    expect(chatgptImportExchangeBody.safeParse({ record }).success).toBe(false);
    expect(chatgptImportExchangeBody.safeParse({
      record,
      json: { raw_json: '{}', source_index: 0 },
      manual: { access_token: 'opaque' },
    }).success).toBe(false);
  });
});

describe('upstreamModelSchema chat', () => {
  test('rejects chat on non-chat kind', () => {
    const body = structuredClone(baseAzure);
    const model = body.manual_models[0] as Record<string, unknown>;
    model.kind = 'embedding';
    model.endpoints = { openaiEmbeddings: {} };
    model.chat = { modalities: { input: ['text'], output: ['text'] } };
    expect(createUpstreamBody.safeParse(body).success).toBe(false);
  });

  test('accepts output modalities without text', () => {
    const body = structuredClone(baseAzure);
    (body.manual_models[0] as Record<string, unknown>).chat = {
      modalities: { input: ['text'], output: ['image'] },
    };
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

  test.each([[['audio'], true], [[], false]] as const)('validates %j inputs identically for manual models and alias announcements', (input, expected) => {
    const chat = { modalities: { input, output: ['text'] } };
    const body = structuredClone(baseAzure);
    Object.assign(body.manual_models[0], { chat });
    expect(createUpstreamBody.safeParse(body).success).toBe(expected);
    expect(createAliasBody.safeParse({
      name: 'a', kind: 'chat', selection: 'first-available', display_name: null, visible_in_models_list: true,
      targets: [{ target_model_id: 'm', rules: {} }], announced_metadata: { chat },
    }).success).toBe(expected);
  });
});

test('upstream creation leaves omitted upstream and model flag overrides absent', () => {
  expect(createUpstreamBody.parse(baseAzure)).toStrictEqual(baseAzure);
});

describe('upstreamModelSchema rerank', () => {
  const customRerank = () => ({
    kind: 'custom' as const,
    name: 'rerank',
    hue: 210,
    config: {
      baseUrl: 'https://rerank.example.com',
      ingressHeadersRules: [],
      apiKey: 'key',
      endpoints: {},
    },
    manual_models: [{
      upstreamModelId: 'reranker',
      kind: 'rerank' as const,
      endpoints: { rerank: {} },
      rerankTarget: { protocol: 'cohere-v2' as const },
    }],
  });

  test('derives rerank from its sole endpoint before validating the target', () => {
    const body = customRerank();
    delete (body.manual_models[0] as Partial<typeof body.manual_models[0]>).kind;
    expect(createUpstreamBody.safeParse(body).success).toBe(true);
  });

});

test('custom upstream creation accepts an empty API key and requires the field', () => {
  const body = {
    kind: 'custom' as const,
    name: 'Anonymous',
    hue: 210,
    config: {
      baseUrl: 'https://anonymous.example.com',
      apiKey: '',
      ingressHeadersRules: [],
      endpoints: {},
    },
  };
  expect(createUpstreamBody.safeParse(body).success).toBe(true);
  delete (body.config as Partial<typeof body.config>).apiKey;
  expect(createUpstreamBody.safeParse(body).success).toBe(false);
});
