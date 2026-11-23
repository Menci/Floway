import { vi } from 'vitest';

import type { GatewayHttpFacts } from '../../../../../src/data-plane/pipeline/host.ts';
import { createGatewayServices, createUsageStore, type GatewayServices, type RouteCandidate } from '../../../../../src/data-plane/pipeline/services.ts';
import type { ApiKey, UsageRecord } from '../../../../../src/repo/types.ts';
import type { FetchInit } from '@floway-dev/http';
import { secret } from '@floway-dev/pipeline';
import { toProviderModelFacts } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

export const config = { enabled: true, upstreamId: 'search-upstream', model: 'search-model' };
const apiKey: ApiKey = {
  id: 'key', userId: 1, name: 'test', key: 'secret', serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01', upstreamIds: null, randomizeUpstreams: true, deletedAt: null, dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
};

export const facts: GatewayHttpFacts = {
  'request.auth.apiKeyId': apiKey.id,
  'request.auth.user': { id: 1, isAdmin: true },
  'request.route.upstreamIds': null,
  'request.route.runtimeLocation': 'TEST',
  'request.route.randomizeUpstreams': true,
  'request.http': { method: 'POST', url: { origin: 'https://floway.test', pathname: '/v1/responses' }, headers: [], body: null },
  'request.startedAt': 0,
};

const model = toProviderModelFacts(stubProviderModel({ id: config.model, upstreamModelId: config.model }));
export const candidate: RouteCandidate = {
  upstreamId: config.upstreamId, upstreamName: 'Search', kind: 'custom',
  upstream: {
    kind: 'custom', id: config.upstreamId, name: 'Search',
    config: {
      baseUrl: 'https://search.example.com',
      apiKey: secret('search-token'),
      ingressHeadersRules: [
        { key: 'x-codex-turn-metadata', value: null },
        { key: 'x-debug', value: null },
      ],
    },
  },
  modelId: model.id, upstreamModelId: model.upstreamModelId, providerModel: model, endpoints: model.endpoints, limits: model.limits,
};

export const fixture = (answer: () => Response, options: {
  readonly candidates?: readonly RouteCandidate[];
} = {}) => {
  const receive = vi.fn(async (_url: string, _init: FetchInit) => answer());
  const usage: UsageRecord[] = [];
  const enumerate = vi.fn<GatewayServices['providers']['enumerate']>(async () => ({
    candidates: options.candidates ?? [candidate], sawModel: true, failedUpstreams: [], staleRefreshes: [],
  }));
  const recordPerformance = vi.fn<GatewayServices['performanceStore']['record']>(async () => {});
  const services = {
    ...createGatewayServices({ apiKey, runtimeLocation: 'TEST' }),
    providers: { enumerate },
    fetcher: () => receive,
    webSearchProvider: Object.assign(async () => ({ type: 'disabled' as const }), { alphaSearch: async () => config }),
    usageStore: createUsageStore(async row => { usage.push(row); }, async () => {}),
    performanceStore: { record: recordPerformance },
  } satisfies GatewayServices;
  return { receive, services, usage, enumerate, recordPerformance };
};
