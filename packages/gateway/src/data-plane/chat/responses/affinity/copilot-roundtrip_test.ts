import { expect, test } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import { prepareResponsesAffinity } from './ingress.ts';
import { AffinityCodec } from '../../shared/affinity/index.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesOutputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { initProviderRepo, providerModelOf, type UpstreamRecord } from '@floway-dev/provider';
import { clearInProcessCopilotTokenCache, copilotProvider } from '@floway-dev/provider-copilot';
import { noopUpstreamCallOptions, sseResponse, stubModelCandidate, stubProvider, withMockedFetch } from '@floway-dev/test-utils';

const upstream: UpstreamRecord = {
  id: 'up-copilot',
  kind: 'copilot',
  name: 'Copilot',
  enabled: true,
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
  color: null,
  config: {
    githubToken: 'ghu_test',
    user: { id: 1, login: 'tester', name: null, avatar_url: 'https://example.com/avatar.png' },
  },
};

const result = (output: ResponsesOutputItem[], status: ResponsesResult['status']): ResponsesResult => ({
  id: 'resp_raw',
  object: 'response',
  model: 'gpt-test',
  output,
  status,
  error: null,
  incomplete_details: null,
});

const sseBody = (events: ResponsesStreamEvent[]): string =>
  `${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

const collectEvents = async (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
): Promise<ResponsesStreamEvent[]> => {
  const events: ResponsesStreamEvent[] = [];
  for await (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }
  return events;
};

test('Copilot item-id and generic affinity trailers compose and unwrap in boundary order', async () => {
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => upstream,
      saveState: async () => ({ updated: true }),
    },
  }));
  clearInProcessCopilotTokenCache();
  const provider = copilotProvider.create(upstream);
  const rawModel = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const candidate = stubModelCandidate({
    provider,
    model: { id: 'gpt-test', endpoints: { responses: {} } },
    providerData: { rawModels: [rawModel] },
  });
  const otherCandidate = stubModelCandidate({
    provider: {
      upstream: 'up-other',
      kind: 'custom',
      name: 'Other',
      disabledPublicModelIds: [],
      modelPrefix: null,
      instance: stubProvider(),
    },
    model: { id: 'gpt-test', endpoints: { responses: {} } },
  });
  const rawReasoning: ResponsesOutputItem = {
    type: 'reasoning',
    id: 'rs_raw',
    summary: [],
    encrypted_content: 'opaque reasoning',
  };
  const completed = result([rawReasoning], 'completed');
  let responsesCalls = 0;
  let replayBody: CanonicalResponsesPayload | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname !== '/responses') throw new Error(`Unhandled fetch ${request.url}`);
      responsesCalls += 1;
      if (responsesCalls === 1) {
        return sseResponse(sseBody([
          { type: 'response.created', response: result([], 'in_progress') },
          { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_added', summary: [] } },
          { type: 'response.output_item.done', output_index: 0, item: rawReasoning },
          { type: 'response.completed', response: completed },
        ]));
      }
      replayBody = await request.json() as CanonicalResponsesPayload;
      return sseResponse();
    },
    async () => {
      const first = await provider.instance.callResponses(
        providerModelOf(candidate),
        { input: [], stream: true, store: false },
        'generate',
        undefined,
        noopUpstreamCallOptions(),
      );
      if (!first.ok || first.action !== 'generate') throw new Error('expected first Copilot stream');

      const codec = new AffinityCodec('00'.repeat(32));
      const publicEvents = await collectEvents(wrapResponsesAffinityEgress(first.events, {
        codec,
        affinity: { upstreamId: provider.upstream, modelId: candidate.model.id },
      }));
      const done = publicEvents.find(event => event.type === 'response.output_item.done');
      if (done?.type !== 'response.output_item.done') throw new Error('expected public done item');
      const publicItem = done.item;
      expect(publicItem.id).toMatch(/^rs_[0-9a-f]{32}$/);
      if (publicItem.type !== 'reasoning') throw new Error('expected public reasoning item');
      expect(publicItem.encrypted_content).not.toBe('opaque reasoning');

      const payload: CanonicalResponsesPayload = {
        model: 'gpt-test',
        input: [publicItem],
        stream: true,
        store: false,
      };
      const prepared = await prepareResponsesAffinity(payload, codec);
      const exact = prepared.payloadForCandidate(candidate);
      const foreign = prepared.payloadForCandidate(otherCandidate);
      expect(exact.input[0]).toMatchObject({ type: 'reasoning', id: publicItem.id });
      expect(foreign.input[0]).toEqual({ type: 'reasoning', id: publicItem.id, summary: [] });

      const { model: _model, ...exactBody } = exact;
      const second = await provider.instance.callResponses(
        providerModelOf(candidate),
        exactBody,
        'generate',
        undefined,
        noopUpstreamCallOptions(),
      );
      if (!second.ok || second.action !== 'generate') throw new Error('expected replay Copilot stream');
    },
  );

  expect(responsesCalls).toBe(2);
  expect(replayBody?.input[0]).toEqual(rawReasoning);
});
