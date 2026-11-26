import { expect, test } from 'vitest';

import { wrapOpenAIResponsesAffinityEgress } from '../../../../../src/data-plane/chat/openai-responses/affinity/egress.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation, stubChatCandidate } from '../../shared/affinity/helpers.ts';
import { run } from '@floway-dev/pipeline';
import { getProviderFetch } from '@floway-dev/platform';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { copilotPipelines, copilotUpstreamFact, createCopilotService } from '@floway-dev/provider-copilot';
import { sseResponse, withMockedFetch } from '@floway-dev/test-utils';

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
  const provider = copilotUpstreamFact(upstream);
  const model = {
    id: 'gpt-test', upstreamModelId: 'gpt-test', endpoints: { openaiResponses: {} },
    providerData: { rawModels: [{ id: 'gpt-test', supported_endpoints: ['/responses'] }] },
  };
  const candidate = stubChatCandidate({ upstream: provider, model });
  const otherCandidate = stubChatCandidate({ upstream: { id: 'up-other' }, model });
  const services = {
    copilot: createCopilotService(),
    fetcher: () => getProviderFetch(),
  };
  const invoke = async (payload: CanonicalOpenAIResponsesPayload): Promise<OpenAIResponsesStreamEventEx[]> => {
    const controller = new AbortController();
    const running = run(copilotPipelines.openaiResponses, {
      'request.http': { method: 'POST', url: 'https://floway.test/v1/responses', headers: [], body: null },
      'provider.upstream': provider,
      'provider.model': candidate.model,
      'request.openaiResponses': payload,
    }, { services, signal: controller.signal, waitUntil: () => {} });
    try {
      const outcome = (await running.result)['response.openaiResponses'];
      if (outcome.kind !== 'stream') throw new Error('Expected a Copilot Responses stream');
      const events: OpenAIResponsesStreamEventEx[] = [];
      for await (const item of running.read(outcome.stream)) {
        if (!item.ok) throw item.error.cause;
        events.push(item.value);
      }
      await running.done;
      return events;
    } finally {
      controller.abort();
    }
  };
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
      return sseResponse(sseBody([{ type: 'response.completed', response: result([], 'completed') }]));
    },
    async () => {
      const first = await invoke({ model: 'gpt-test', input: [], stream: true, store: false });
      const frames = async function* () { for (const event of first) yield eventFrame(event); };

      const codec = new AffinityCodec('00'.repeat(32));
      const publicEvents = await collectEvents(wrapOpenAIResponsesAffinityEgress(frames(), {
        codec,
        affinity: {
          upstreamId: provider.id,
          modelId: candidate.model.id,
          opaqueBlobCompatibilityIdentity: { upstreamId: provider.id, key: candidate.model.id },
        },
      }));
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
      const exact = acceptedAffinityEvaluation(prepared, candidate).materialize();
      const incompatible = acceptedAffinityEvaluation(prepared, otherCandidate).materialize();
      expect(exact.input[0]).toMatchObject({ type: 'reasoning', id: publicItem.id });
      expect(incompatible.input).toEqual([]);

      await invoke(exact);
    },
  );

  expect(openaiResponsesCalls).toBe(2);
  expect(replayBody?.input[0]).toEqual(rawReasoning);
});
