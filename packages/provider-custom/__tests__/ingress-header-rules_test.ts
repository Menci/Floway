import { test } from 'vitest';

import { callCustom, customInput } from './pipeline-fixture.ts';
import type { CustomIngressHeaderRule } from '../src/config.ts';
import { customPipelines } from '../src/pipelines.ts';
import { createCustomProvider } from '../src/provider.ts';
import { Bytes } from '@floway-dev/pipeline';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import { directFetcher, type Fetcher, type HeaderEntry, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

const HEADER = 'x-route';

const buildCustomUpstream = (ingressHeadersRules: CustomIngressHeaderRule[], models: UpstreamModelConfig[]): UpstreamRecord => ({
  id: 'up_custom',
  kind: 'custom',
  name: 'Custom Provider',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
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
    apiKey: 'sk-test',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules,
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models,
  },
});

const CHAT_MODEL: UpstreamModelConfig[] = [{ upstreamModelId: 'chat', kind: 'chat', endpoints: { openaiChatCompletions: {} } }];

// What the operator configures for one header name. `null` is the passthrough
// preset, `''` the empty preset, anything else a typed value.
const RULES: Record<string, CustomIngressHeaderRule[]> = {
  passthrough: [{ key: HEADER, value: null }],
  'passthrough after a value': [{ key: HEADER, value: 'one' }, { key: HEADER, value: null }],
  'empty beside a value': [{ key: HEADER, value: '' }, { key: HEADER, value: 'one' }],
};

const INCOMING: Record<string, readonly HeaderEntry[]> = {
  'client sends nothing': [],
  'client sends two values': [[HEADER, 'client-a'], ['X-Route', 'client-b']],
};

// The upstream's `x-route` field lines for each pair, stated from the rule
// contract rather than read back from the resolver.
const EXPECTED: Record<string, Record<string, string[]>> = {
  passthrough: {
    'client sends nothing': [],
    'client sends two values': ['client-a, client-b'],
  },
  'passthrough after a value': {
    'client sends nothing': ['one'],
    'client sends two values': ['one', 'client-a, client-b'],
  },
  'empty beside a value': {
    'client sends nothing': ['', 'one'],
    'client sends two values': ['', 'one'],
  },
};

// The provider hands the transport field lines, so the lines themselves are
// what these cases read — a `Request`'s `Headers` would merge a repeated name
// back into one value and hide exactly what is under test.
const upstreamLines = async (rules: CustomIngressHeaderRule[], incoming: readonly HeaderEntry[]): Promise<[string, string][]> => {
  const record = buildCustomUpstream(rules, CHAT_MODEL);
  const provider = createCustomProvider(record);
  let observed: [string, string][] | undefined;
  const fetcher: Fetcher = (_url, init) => {
    observed = init.headers as [string, string][];
    return Promise.resolve(sseResponse());
  };

  const [model] = await provider.instance.getProvidedModels(directFetcher);
  assertExists(model);
  await callCustom(
    customPipelines.openaiChatCompletions,
    customInput(record, model, { messages: [] }, [...incoming, ['x-untouched', 'removed']]),
    fetcher,
  );

  assertExists(observed);
  return observed;
};

const valuesFor = (lines: readonly (readonly [string, string])[], name: string): string[] =>
  lines.flatMap(([candidate, value]) => candidate.toLowerCase() === name ? [value] : []);

for (const [ruleName, rules] of Object.entries(RULES)) {
  for (const [clientName, incoming] of Object.entries(INCOMING)) {
    test(`${ruleName}: ${clientName}`, async () => {
      const lines = await upstreamLines(rules, incoming);

      assertEquals(valuesFor(lines, HEADER), EXPECTED[ruleName][clientName]);
      assertEquals(valuesFor(lines, 'x-untouched'), []);
    });
  }
}

test('one passthrough value and multiple configured values reach the transport in rule order', async () => {
  const lines = await upstreamLines([
    { key: HEADER, value: null },
    { key: HEADER, value: 'one' },
    { key: 'x-configured', value: 'two' },
    { key: 'x-configured', value: 'three' },
  ], [[HEADER, 'client'], ['x-configured', 'removed'], ['Authorization', 'Bearer client'], ['content-type', 'text/plain']]);

  assertEquals(valuesFor(lines, HEADER), ['client', 'one']);
  assertEquals(valuesFor(lines, 'x-configured'), ['two', 'three']);
  assertEquals(valuesFor(lines, 'authorization'), ['Bearer sk-test']);
  assertEquals(valuesFor(lines, 'content-type'), ['application/json']);
});

test('every endpoint resolves the same rules', async () => {
  const rules: CustomIngressHeaderRule[] = [
    { key: HEADER, value: null },
    { key: HEADER, value: 'appended' },
  ];
  const record = buildCustomUpstream(rules, [
    {
      upstreamModelId: 'chat', kind: 'chat', endpoints: {
        openaiAudioTranscriptions: {},
        openaiChatCompletions: {},
        openaiCompletions: {},
        openaiEmbeddings: {},
        openaiImagesEdits: {},
        openaiImagesGenerations: {},
        anthropicMessages: {},
        geminiGenerateContent: {},
        openaiResponses: {},
      },
    },
    { upstreamModelId: 'reranker', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } },
    { upstreamModelId: 'decider', kind: 'decision', endpoints: { decision: {} }, decisionTarget: { protocol: 'typesafe-systemone' } },
  ]);
  const provider = createCustomProvider(record);
  const observed: Record<string, string | null> = {};

  await withMockedFetch(
    request => {
      const { pathname } = new URL(request.url);
      observed[pathname] = request.headers.get(HEADER);
      if (pathname === '/v1/chat/completions' || pathname === '/v1/responses' || pathname === '/v1/messages' || pathname.endsWith(':streamGenerateContent')) return sseResponse();
      return jsonResponse({});
    },
    async () => {
      const models = await provider.instance.getProvidedModels(directFetcher);
      const model = models.find(candidate => candidate.upstreamModelId === 'chat');
      const rerankModel = models.find(candidate => candidate.upstreamModelId === 'reranker');
      const decisionModel = models.find(candidate => candidate.upstreamModelId === 'decider');
      assertExists(model);
      assertExists(rerankModel);
      assertExists(decisionModel);
      const headers = [[HEADER, 'client-a']] as const;
      const input = <Payload>(payload: Payload) => customInput(record, model, payload, headers);
      const messages = {
        ...input({ max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] }),
        'request.anthropicBeta': [],
      };

      const alphaSearch = await callCustom(customPipelines.alphaSearch, input({ query: 'hi' }));
      assertEquals(alphaSearch['response.alphaSearch'].kind, 'ok');
      const chat = await callCustom(customPipelines.openaiChatCompletions, input({ messages: [] }));
      assertEquals(chat['response.openaiChatCompletions'].kind, 'stream');
      const completions = await callCustom(customPipelines.openaiCompletions, input({ prompt: 'hi' }));
      assertEquals(completions['response.openaiCompletions'].kind, 'ok');
      const generate = await callCustom(customPipelines.openaiResponses, { ...input({ input: [] }), 'request.action': 'generate' });
      assertEquals(generate['response.openaiResponses'].kind, 'stream');
      const compact = await callCustom(customPipelines.openaiResponses, { ...input({ input: [] }), 'request.action': 'compact' });
      assertEquals(compact['response.openaiResponses'].kind, 'result');
      const anthropic = await callCustom(customPipelines.anthropicMessages, messages);
      assertEquals(anthropic['response.anthropicMessages'].kind, 'stream');
      const anthropicCount = await callCustom(customPipelines.anthropicMessagesCountTokens, messages);
      assertEquals(anthropicCount['response.anthropicMessagesCountTokens'].kind, 'ok');
      const gemini = await callCustom(customPipelines.geminiGenerateContent, input({ contents: [] }));
      assertEquals(gemini['response.geminiGenerateContent'].kind, 'stream');
      const geminiCount = await callCustom(customPipelines.geminiGenerateContentCountTokens, input({ contents: [] }));
      assertEquals(geminiCount['response.geminiGenerateContentCountTokens'].kind, 'ok');
      const embeddings = await callCustom(customPipelines.openaiEmbeddings, input({ input: 'hi' }));
      assertEquals(embeddings['response.openaiEmbeddings'].kind, 'ok');
      const images = await callCustom(customPipelines.openaiImagesGenerations, input({ prompt: 'hi' }));
      assertEquals(images['response.openaiImagesGenerations'].kind, 'ok');
      const edits = await callCustom(customPipelines.openaiImagesEdits, input({
        parameters: { prompt: 'hi' },
        images: [{ type: 'upload', bytes: Bytes.fromUtf8('photo'), filename: 'photo.png', contentType: 'image/png' }],
      }));
      assertEquals(edits['response.openaiImagesEdits'].kind, 'ok');
      const audio = await callCustom(customPipelines.openaiAudioTranscriptions, input({
        entries: [{ kind: 'file', name: 'file', bytes: Bytes.fromUtf8('voice'), filename: 'voice.ogg', contentType: 'audio/ogg' }],
      }));
      assertEquals(audio['response.openaiAudioTranscriptions'].kind, 'ok');
      const rerank = parseRerankRequest('cohere-v1', { model: 'reranker', query: 'query', documents: ['one'] }).request;
      const ranked = await callCustom(customPipelines.rerank, customInput(record, rerankModel, rerank, headers));
      assertEquals(ranked['response.rerank'], { kind: 'ok', target: { protocol: 'cohere-v2' } });
      const decision = parseDecisionRequest('typesafe-systemone', {
        model: 'decider', state: 'evidence', questions: { yes: { type: 'noul', instructions: 'Is it true?' } },
      }).request;
      const decided = await callCustom(customPipelines.decision, customInput(record, decisionModel, decision, headers));
      assertEquals(decided['response.decision'], { kind: 'ok', target: { protocol: 'typesafe-systemone' } });
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
    '/v1/systemone': 'client-a, appended',
    '/v2/rerank': 'client-a, appended',
    '/v1beta/models/chat:countTokens': 'client-a, appended',
    '/v1beta/models/chat:streamGenerateContent': 'client-a, appended',
  });
});
