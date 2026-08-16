import { test } from 'vitest';

import type { CustomIngressHeaderRule } from '../src/config.ts';
import { createCustomProvider } from '../src/provider.ts';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, noopMessagesUpstreamCallOptions, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

const HEADER = 'x-route';

const buildCustomUpstream = (ingressHeadersRules: CustomIngressHeaderRule[], models: UpstreamModelConfig[]): UpstreamRecord => ({
  id: 'up_custom',
  kind: 'custom',
  name: 'Custom Provider',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-test',
    endpoints: { chatCompletions: {} },
    ingressHeadersRules,
    modelsFetch: { enabled: false },
    models,
  },
});

const CHAT_MODEL: UpstreamModelConfig[] = [{ upstreamModelId: 'chat', kind: 'chat', endpoints: { chatCompletions: {} } }];

// What the operator configures for one header name. `null` is the passthrough
// preset, `''` the empty preset, anything else a typed value. An empty rule
// list is how the operator keeps a name away from this upstream.
const RULES: Record<string, CustomIngressHeaderRule[]> = {
  'no rule': [],
  passthrough: [{ key: HEADER, value: null }],
  'one value': [{ key: HEADER, value: 'one' }],
  'two values': [{ key: HEADER, value: 'one' }, { key: HEADER, value: 'two' }],
  'passthrough before a value': [{ key: HEADER, value: null }, { key: HEADER, value: 'one' }],
  'passthrough after a value': [{ key: HEADER, value: 'one' }, { key: HEADER, value: null }],
  'empty beside a value': [{ key: HEADER, value: '' }, { key: HEADER, value: 'one' }],
};

// What the client sent. A name the upstream admits arrives combined into one
// field value, which is how both runtimes and the gateway's own filter hand a
// repeated name to a provider.
const ADMITTED: Record<string, string | null> = {
  'client sends nothing': null,
  'client sends one value': 'client-a',
  'client sends two values': 'client-a, client-b',
};

// The upstream's `x-route` for each pair, stated from the rule contract rather
// than read back from the resolver.
const EXPECTED: Record<string, Record<string, string | null>> = {
  'no rule': {
    'client sends nothing': null,
    'client sends one value': null,
    'client sends two values': null,
  },
  passthrough: {
    'client sends nothing': null,
    'client sends one value': 'client-a',
    'client sends two values': 'client-a, client-b',
  },
  'one value': {
    'client sends nothing': 'one',
    'client sends one value': 'one',
    'client sends two values': 'one',
  },
  'two values': {
    'client sends nothing': 'one, two',
    'client sends one value': 'one, two',
    'client sends two values': 'one, two',
  },
  'passthrough before a value': {
    'client sends nothing': 'one',
    'client sends one value': 'client-a, one',
    'client sends two values': 'client-a, client-b, one',
  },
  'passthrough after a value': {
    'client sends nothing': 'one',
    'client sends one value': 'one, client-a',
    'client sends two values': 'one, client-a, client-b',
  },
  'empty beside a value': {
    'client sends nothing': ', one',
    'client sends one value': ', one',
    'client sends two values': ', one',
  },
};

// The bag a provider receives has already passed the gateway's admission
// filter, so a name the instance does not admit never carries a client value.
const admittedBag = (allowlist: readonly unknown[], admitted: string | null): Headers => {
  const headers = new Headers({ 'x-untouched': 'kept' });
  if (admitted !== null && allowlist.includes(HEADER)) headers.set(HEADER, admitted);
  return headers;
};

const upstreamHeaders = async (rules: CustomIngressHeaderRule[], admitted: string | null): Promise<Headers> => {
  const provider = createCustomProvider(buildCustomUpstream(rules, CHAT_MODEL));
  let observed: Headers | undefined;

  await withMockedFetch(
    request => {
      observed = request.headers;
      return sseResponse();
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      assertExists(model);
      await provider.instance.callChatCompletions(
        model,
        { messages: [] },
        undefined,
        noopUpstreamCallOptions({ headers: admittedBag(provider.inboundHeaderAllowlist, admitted) }),
      );
    },
  );

  assertExists(observed);
  return observed;
};

for (const [ruleName, rules] of Object.entries(RULES)) {
  for (const [clientName, admitted] of Object.entries(ADMITTED)) {
    test(`${ruleName}: ${clientName}`, async () => {
      const observed = await upstreamHeaders(rules, admitted);

      assertEquals(observed.get(HEADER), EXPECTED[ruleName][clientName]);
      assertEquals(observed.get('x-untouched'), 'kept');
    });
  }
}

test('a name is admitted once however many values it sends', () => {
  const provider = createCustomProvider(buildCustomUpstream([
    { key: HEADER, value: null },
    { key: HEADER, value: 'one' },
    { key: 'x-configured', value: 'two' },
    { key: 'x-configured', value: 'three' },
  ], CHAT_MODEL));

  assertEquals([...provider.inboundHeaderAllowlist], [HEADER]);
});

test('every endpoint resolves the same rules', async () => {
  const rules: CustomIngressHeaderRule[] = [
    { key: HEADER, value: null },
    { key: HEADER, value: 'appended' },
  ];
  const provider = createCustomProvider(buildCustomUpstream(rules, [
    {
      upstreamModelId: 'chat', kind: 'chat', endpoints: {
        audioTranscriptions: {},
        chatCompletions: {},
        completions: {},
        embeddings: {},
        imagesEdits: {},
        imagesGenerations: {},
        messages: {},
        responses: {},
      },
    },
    { upstreamModelId: 'reranker', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } },
  ]));
  const observed: Record<string, string | null> = {};

  await withMockedFetch(
    request => {
      const { pathname } = new URL(request.url);
      observed[pathname] = request.headers.get(HEADER);
      if (pathname === '/v1/chat/completions' || pathname === '/v1/responses' || pathname === '/v1/messages') return sseResponse();
      return jsonResponse({});
    },
    async () => {
      const models = await provider.instance.getProvidedModels(directFetcher);
      const model = models.find(candidate => candidate.kind !== 'rerank');
      const rerankModel = models.find(candidate => candidate.kind === 'rerank');
      assertExists(model);
      assertExists(rerankModel);
      const headers = () => admittedBag(provider.inboundHeaderAllowlist, 'client-a');
      const opts = () => noopUpstreamCallOptions({ headers: headers() });
      const messagesOpts = () => noopMessagesUpstreamCallOptions({ headers: headers() });
      const messagesBody = { max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

      await provider.instance.callAlphaSearch(model, { query: 'hi' }, undefined, opts());
      await provider.instance.callChatCompletions(model, { messages: [] }, undefined, opts());
      await provider.instance.callCompletions(model, { prompt: 'hi' }, undefined, opts());
      await provider.instance.callResponses(model, { input: [] }, 'generate', undefined, opts());
      await provider.instance.callResponses(model, { input: [] }, 'compact', undefined, opts());
      await provider.instance.callMessages(model, messagesBody, undefined, messagesOpts());
      await provider.instance.callMessagesCountTokens(model, messagesBody, undefined, messagesOpts());
      await provider.instance.callEmbeddings(model, { input: 'hi' }, undefined, opts());
      await provider.instance.callImagesGenerations(model, { prompt: 'hi' }, undefined, opts());
      await provider.instance.callImagesEdits(model, {
        parameters: { prompt: 'hi' },
        images: [{ type: 'upload', file: new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' }) }],
      }, undefined, opts());
      await provider.instance.callAudioTranscriptions(model, {
        entries: [{ name: 'file', value: new File([new Uint8Array([1])], 'voice.ogg', { type: 'audio/ogg' }) }],
      }, undefined, opts());
      await provider.instance.callRerank(
        rerankModel,
        parseRerankRequest('cohere-v1', { model: 'reranker', query: 'query', documents: ['one'] }).request,
        undefined,
        opts(),
      );
    },
  );

  assertEquals(observed, {
    '/v1/alpha/search': 'client-a, appended',
    '/v1/audio/transcriptions': 'client-a, appended',
    '/v1/chat/completions': 'client-a, appended',
    '/v1/completions': 'client-a, appended',
    '/v1/embeddings': 'client-a, appended',
    '/v1/images/edits': 'client-a, appended',
    '/v1/images/generations': 'client-a, appended',
    '/v1/messages': 'client-a, appended',
    '/v1/messages/count_tokens': 'client-a, appended',
    '/v1/responses': 'client-a, appended',
    '/v1/responses/compact': 'client-a, appended',
    '/v2/rerank': 'client-a, appended',
  });
});
