import { expect, test } from 'vitest';

import { wrapOpenAIResponsesAffinityEgress } from '../../../../../src/data-plane/chat/openai-responses/affinity/egress.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { noopUpstreamCallOptions, sseResponse, stubModelCandidate, stubUpstream, withMockedFetch } from '@floway-dev/test-utils';
import { initUpstreamRuntimeRepo, type UpstreamRecord } from '@floway-dev/upstream';
import { clearInProcessCopilotTokenCache, copilotUpstreamModule } from '@floway-dev/upstream-copilot';

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
  initUpstreamRuntimeRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, version: 1 }),
      saveState: async () => {},
    },
  }));
  clearInProcessCopilotTokenCache();
  const copilotUpstream = copilotUpstreamModule.create(upstream);
  const rawModel = { id: 'gpt-test', supported_endpoints: ['/responses'] };
  const candidate = stubModelCandidate({
    upstream: copilotUpstream,
    model: { id: 'gpt-test', endpoints: { openaiResponses: {} } },
    upstreamData: { rawModels: [rawModel] },
  });
  const otherCandidate = stubModelCandidate({
    upstream: {
      upstreamId: 'up-other',
      kind: 'custom',
      name: 'Other',
      inboundHeaderAllowlist: [],
      instance: stubUpstream(),
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
      const first = await copilotUpstream.instance.callOpenAIResponses(
        candidate.model,
        { input: [], stream: true, store: false },
        'generate',
        undefined,
        noopUpstreamCallOptions(),
      );
      if (!first.ok || first.action !== 'generate') throw new Error('expected first Copilot stream');

      const codec = new AffinityCodec('00'.repeat(32));
      const publicEvents = await collectEvents(wrapOpenAIResponsesAffinityEgress(first.events, {
        codec,
        affinity: {
          upstreamId: copilotUpstream.upstreamId,
          modelId: candidate.model.id,
          opaqueBlobCompatibilityIdentity: { upstreamId: copilotUpstream.upstreamId, key: candidate.model.id },
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

      const { model: _model, ...exactBody } = exact;
      const second = await copilotUpstream.instance.callOpenAIResponses(
        candidate.model,
        exactBody,
        'generate',
        undefined,
        noopUpstreamCallOptions(),
      );
      if (!second.ok || second.action !== 'generate') throw new Error('expected replay Copilot stream');
    },
  );

  expect(openaiResponsesCalls).toBe(2);
  expect(replayBody?.input[0]).toEqual(rawReasoning);
});
