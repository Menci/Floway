import { expect, test } from 'vitest';

import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { openaiResponsesHttpEntry } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import { responsesTestServices } from '../pipeline/fixtures.ts';
import type { Fetcher } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { initUpstreamRuntimeRepo, toUpstreamSnapshot, type UpstreamRecord } from '@floway-dev/upstream';
import { clearInProcessCopilotTokenCache, createCopilotServices } from '@floway-dev/upstream-copilot';

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
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
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

const sseResponse = (events: OpenAIResponsesStreamEventEx[]) => new Response(sseBody(events), { headers: { 'content-type': 'text/event-stream' } });

test('Copilot item-id and generic affinity trailers compose and unwrap in boundary order', async () => {
  initRepo(new InMemoryRepo());
  const defaults = responsesTestServices();
  initUpstreamRuntimeRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: { getById: async () => ({ ...upstream, version: 1 }), saveState: async () => {} },
  }));
  clearInProcessCopilotTokenCache();
  const model = {
    ...candidateFor(upstream.id).model,
    id: 'gpt-test', upstreamModelId: 'gpt-test', endpoints: { openaiResponses: {} },
    upstreamData: { rawModels: [{ id: 'gpt-test', supported_endpoints: ['/responses'] }] },
  };
  const candidate = { upstream: toUpstreamSnapshot(upstream), model };
  const rawReasoning: OpenAIResponsesOutputItemEx = {
    type: 'reasoning', id: 'rs_raw', summary: [], encrypted_content: 'opaque reasoning',
  };
  let calls = 0;
  let replay: CanonicalOpenAIResponsesPayload | undefined;
  const fetcher: Fetcher = async (url, init) => {
    expect(new URL(url).pathname).toBe('/responses');
    if (++calls === 1) return sseResponse([
      { type: 'response.created', response: result([], 'in_progress') },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_added', summary: [] } },
      { type: 'response.output_item.done', output_index: 0, item: rawReasoning },
      { type: 'response.completed', response: result([rawReasoning], 'completed') },
    ]);
    if (typeof init.body !== 'string') throw new TypeError('Expected Copilot Responses JSON');
    replay = JSON.parse(init.body) as CanonicalOpenAIResponsesPayload;
    return sseResponse([{ type: 'response.completed', response: result([], 'completed') }]);
  };
  const request = async (payload: CanonicalOpenAIResponsesPayload): Promise<OpenAIResponsesResultEx> => {
    const host = hostFor({
      ...responsesTestServices(), ...createCopilotServices({ fetcher: () => fetcher }),
      catalogCandidates: async () => ({ candidates: [candidate], sawModel: true }),
    });
    const running = run(openaiResponsesHttpEntry, {
      http: { url: 'https://floway.test/v1/responses', headers: [], method: 'POST', body: new TextEncoder().encode(JSON.stringify(payload)) },
      'serve.startedAt': Date.now(),
    }, host.options);
    const answer = await running.result;
    try {
      expect(answer.http?.status).toBe(200);
      const body = answer.http?.body;
      if (!(body instanceof Uint8Array)) throw new TypeError('Expected a collected Responses resource');
      return JSON.parse(new TextDecoder().decode(body)) as OpenAIResponsesResultEx;
    } finally {
      host.controller.abort();
      running.discard(answer);
      await host.settle();
      expect(host.errors).toEqual([]);
    }
  };

  const first = await request({ model: model.id, input: [], store: false });
  const publicItem = first.output[0];
  expect(publicItem.id).toMatch(/^rs_[0-9a-f]{32}$/);
  if (publicItem.type !== 'reasoning') throw new Error('Expected public reasoning');
  expect(publicItem.encrypted_content).not.toBe(rawReasoning.encrypted_content);

  const payload: CanonicalOpenAIResponsesPayload = { model: model.id, input: [publicItem], store: false };
  const prepared = await analyzeOpenAIResponsesAffinity(payload, defaults.affinity);
  const exact = acceptedAffinityEvaluation(prepared, { upstream: { upstreamId: upstream.id }, model }).materialize();
  const incompatible = acceptedAffinityEvaluation(prepared, { upstream: { upstreamId: 'up-other' }, model }).materialize();
  expect(exact.input[0]).toMatchObject({ type: 'reasoning', id: publicItem.id });
  expect(incompatible.input).toEqual([]);

  await request(payload);
  expect(calls).toBe(2);
  expect(replay?.input[0]).toEqual(rawReasoning);
});
