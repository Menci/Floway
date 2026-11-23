import { expect, test } from 'vitest';

import { routeCandidate } from './fixture.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../../../../../src/data-plane/chat/openai-responses/affinity/egress.ts';
import { analyzeOpenAIResponsesAffinity, evaluateOpenAIResponsesCandidate } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import { run } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { initProviderRepo, providerModelOf, toProviderModelFacts, type UpstreamRecord } from '@floway-dev/provider';
import { clearInProcessCopilotTokenCache, copilotProviderModule } from '@floway-dev/provider-copilot';
import { sseResponse, stubModelCandidate, stubProvider, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const upstream: UpstreamRecord = {
  id: 'up-copilot',
  kind: 'copilot',
  name: 'Copilot',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
  state: {
    knownModels: null,
    copilotToken: {
      token: 'copilot-token',
      expiresAt: Date.now() + 3_600_000,
      baseUrl: 'https://api.individual.githubcopilot.com',
    },
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    githubHost: 'github.com',
    githubToken: 'ghu_test',
    user: { id: 1, login: 'tester', name: null, avatar_url: 'https://example.com/avatar.png' },
  },
};

const result = (output: OpenAIResponsesOutputItemEx[], status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_raw',
  object: 'response',
  model: 'gpt-test',
  output,
  status,
  error: null,
  incomplete_details: null,
});

const sseBody = (events: OpenAIResponsesStreamEventEx[]): string =>
  `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

const collectEvents = async (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
): Promise<OpenAIResponsesStreamEventEx[]> => {
  const events: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }
  return events;
};

test('Copilot item-id and generic affinity trailers compose and unwrap in boundary order', async () => {
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, configVersion: 1 }),
      saveState: async () => {},
    },
  }));
  clearInProcessCopilotTokenCache();
  const provider = copilotProviderModule.create(upstream);
  const rawModel = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const candidate = stubModelCandidate({
    provider,
    model: { id: 'gpt-test', endpoints: { openaiResponses: {} } },
    providerData: { rawModels: [rawModel] },
  });
  const otherCandidate = stubModelCandidate({
    provider: {
      upstreamId: 'up-other',
      kind: 'custom',
      name: 'Other',
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      pipelines: {},
      instance: stubProvider(),
    },
    model: { id: 'gpt-test', endpoints: { openaiResponses: {} } },
  });
  const rawReasoning: OpenAIResponsesOutputItemEx = {
    type: 'reasoning',
    id: 'rs_raw',
    summary: [],
    encrypted_content: 'opaque reasoning',
  };
  const completed = result([rawReasoning], 'completed');
  let openaiResponsesCalls = 0;
  let replayBody: CanonicalOpenAIResponsesPayload | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname !== '/responses') throw new Error(`Unhandled fetch ${request.url}`);
      openaiResponsesCalls += 1;
      if (openaiResponsesCalls === 1) {
        return sseResponse(sseBody([
          { type: 'response.created', response: result([], 'in_progress') },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_added', summary: [] } },
          { type: 'response.output_item.done', output_index: 0, item: rawReasoning },
          { type: 'response.completed', response: completed },
        ]));
      }
      replayBody = await request.json() as CanonicalOpenAIResponsesPayload;
      return sseResponse();
    },
    async () => {
      const pipeline = provider.pipelines.openaiResponses;
      if (pipeline === undefined) throw new Error('Expected Copilot Responses pipeline');
      const invoke = (payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>) => run(pipeline, {
        'provider.model': toProviderModelFacts(providerModelOf(candidate)),
        'request.headers': [], 'request.action': 'generate', 'request.payload': payload,
      }, { services: { fetcher: () => testFetcher }, finalizationTimeoutMs: 2000 });
      const first = invoke({ input: [], stream: true, store: false });
      const { 'response.events': firstEvents } = await first.result;
      if (firstEvents === undefined) throw new Error('Expected first Copilot stream');

      const codec = new AffinityCodec('00'.repeat(32));
      const publicEvents = await collectEvents(wrapOpenAIResponsesAffinityEgress(firstEvents, {
        codec,
        affinity: {
          upstreamId: provider.upstreamId,
          modelId: candidate.model.id,
          opaqueBlobCompatibilityIdentity: { upstreamId: provider.upstreamId, key: candidate.model.id },
        },
      }));
      expect(await first.done).toEqual({ ok: true });
      const done = publicEvents.find(event => event.type === 'response.output_item.done');
      if (done?.type !== 'response.output_item.done') throw new Error('expected public done item');
      const publicItem = done.item;
      expect(publicItem.id).toMatch(/^rs_[0-9a-f]{32}$/);
      if (publicItem.type !== 'reasoning') throw new Error('expected public reasoning item');
      expect(publicItem.encrypted_content).not.toBe('opaque reasoning');

      const payload: CanonicalOpenAIResponsesPayload = {
        model: 'gpt-test',
        input: [publicItem],
        stream: true,
        store: false,
      };
      const prepared = await analyzeOpenAIResponsesAffinity(payload, codec);
      const accepted = evaluateOpenAIResponsesCandidate(prepared, routeCandidate(candidate), payload);
      const degraded = evaluateOpenAIResponsesCandidate(prepared, routeCandidate(otherCandidate), payload);
      if (accepted.kind !== 'accepted' || degraded.kind !== 'accepted') throw new Error('Expected both candidate projections');
      const exact = accepted.payload;
      const incompatible = degraded.payload;
      expect(exact.input[0]).toMatchObject({ type: 'reasoning', id: publicItem.id });
      expect(incompatible.input).toEqual([]);

      const { model: _model, ...exactBody } = exact;
      const second = invoke(exactBody);
      const { 'response.events': replayEvents } = await second.result;
      if (replayEvents === undefined) throw new Error('Expected replay Copilot stream');
      await replayEvents.close();
      expect(await second.done).toEqual({ ok: true });
    },
  );

  expect(openaiResponsesCalls).toBe(2);
  expect(replayBody?.input[0]).toEqual(rawReasoning);
});
