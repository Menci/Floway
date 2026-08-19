// The two families that read their answer to the end, driven end to end. Until the review,
// neither could express a status at all: an upstream 429, a resolver's 404 and a 400 all
// reached the client as a 200 carrying an error envelope, which is not a difference the
// no-passthrough ruling asks for — declining to forward a body is not declining to forward
// a status.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enumerateModelCandidates } from '../../src/data-plane/providers/resolution.ts';
import { rerankServePipeline } from '../../src/data-plane/rerank/pipeline.ts';
import { initRepo } from '../../src/repo/index.ts';
import { mockGatewayCtx } from '../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
import { directFetcher, type ModelCandidate, type ProviderRerankCallResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../src/data-plane/providers/resolution.ts', () => ({
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

const candidate = (upstream: string, callRerank: () => Promise<ProviderRerankCallResult>): ModelCandidate => {
  const endpoints = { rerank: {} };
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callRerank }),
    },
    model: stubInternalModel(
      { id: 'rr', endpoints, providerModels: { [upstream]: stubProviderModel({ id: 'rr', endpoints, rerankTarget: { protocol: 'cohere-v2' } }) } },
      upstream,
    ),
    fetcher: directFetcher,
  } as unknown as ModelCandidate;
};

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] } as never);
};

const request: CanonicalRerankRequest = {
  sourceProtocol: 'cohere-v2', raw: {}, query: 'q', documents: ['a', 'b'],
};

const serve = async () => await run(
  rerankServePipeline(request),
  move({
    'ingress.rerank.sourceProtocol': 'cohere-v2',
    'ingress.http.headers': [] as readonly (readonly [string, string])[],
    'request.rerank.canonical': request,
    'serve.model': 'rr',
  }) as never,
  {
    gateway: mockGatewayCtx({ wantsStream: false }),
    background: () => {},
    rememberCandidates: () => {},
    resolveAttempt: (selector: { readonly upstreamId: string }) => {
      const found = live.find(c => c.provider.upstreamId === selector.upstreamId);
      if (found === undefined) throw new Error(`no live candidate for ${selector.upstreamId}`);
      return found;
    },
  } as never,
);

beforeEach(() => {
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('a rerank answer carries its status', () => {
  it('serves a success as 200', async () => {
    resolves([candidate('up_a', async () => ({
      response: Response.json({ results: [{ index: 0, relevance_score: 0.9 }], meta: { billed_units: { search_units: 1 } } }),
      modelKey: 'rr-key',
      target: { protocol: 'cohere-v2' },
    } as ProviderRerankCallResult))]);
    const { facts } = await serve();
    expect(facts['response.http.status']).toBe(200);
  });

  // The case that reached the client as a 200 before: a refusal the client has to be able
  // to act on, and a retry-after only means something alongside the status that implies it.
  it('serves an upstream refusal with the upstream-s own status', async () => {
    resolves([candidate('up_a', async () => ({
      response: new Response('slow down', { status: 429 }),
      modelKey: 'rr-key',
      target: { protocol: 'cohere-v2' },
    } as ProviderRerankCallResult))]);
    const { facts } = await serve();
    expect(facts['response.http.status']).toBe(429);
  });

  it('serves the resolver-s own refusal with the status it chose', async () => {
    vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates: [], sawModel: false, failedUpstreams: [] } as never);
    const { facts } = await serve();
    expect(facts['response.http.status']).toBe(404);
  });
});
