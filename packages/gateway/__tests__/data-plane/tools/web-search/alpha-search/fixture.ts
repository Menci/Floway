import { vi } from 'vitest';

import type { GatewayHttpFacts } from '../../../../../src/data-plane/pipeline/host.ts';
import { createGatewayServices, type GatewayServices, type RouteCandidate } from '../../../../../src/data-plane/pipeline/services.ts';
import type { ApiKey, UsageRecord } from '../../../../../src/repo/types.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { compose, defineEnding } from '@floway-dev/pipeline';
import { type ProviderHttpOutput, type ProviderInput, type ProviderServices, toProviderModelFacts } from '@floway-dev/provider';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

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
};

const model = toProviderModelFacts(stubProviderModel({ id: config.model, upstreamModelId: config.model }));
export const candidate: RouteCandidate = {
  upstreamId: config.upstreamId, upstreamName: 'Search', kind: 'chatgpt',
  modelId: model.id, upstreamModelId: model.upstreamModelId, providerModel: model, endpoints: model.endpoints, limits: model.limits,
};

export const fixture = (answer: (input: ProviderInput<Record<string, unknown>>) => HttpResponseFacts, options: {
  readonly candidates?: readonly RouteCandidate[];
  readonly unsupported?: boolean;
} = {}) => {
  const receive = vi.fn(answer);
  type Input = ProviderInput<Record<string, unknown>>;
  const pipeline = compose<Input, ProviderHttpOutput, ProviderServices>('test.alpha.provider', {
    stages: [],
    ending: defineEnding<Input, ProviderHttpOutput, {}, ProviderServices>({
      name: 'alpha',
      request: { needs: ['provider.model', 'request.headers', 'request.payload'] },
      return: { provides: ['response.http', 'response.modelKey'] },
      execute: async input => ({ 'response.http': receive(input), 'response.modelKey': model.upstreamModelId }),
    }),
  });
  const provider = {
    ...stubModelCandidate().provider, upstreamId: config.upstreamId, name: 'Search',
    configVersion: 1, modelsRefreshInputHash: 'cache-key',
    inboundHeaderAllowlist: ['x-codex-turn-metadata'],
    pipelines: options.unsupported ? {} : { alphaSearch: pipeline },
  };
  const usage: UsageRecord[] = [];
  const enumerate = vi.fn<GatewayServices['providers']['enumerate']>(async () => ({ candidates: options.candidates ?? [candidate], sawModel: true, failedUpstreams: [] }));
  const services = {
    ...createGatewayServices({ apiKey, runtimeLocation: 'TEST', scheduler: () => {} }),
    providers: { resolve: () => provider, enumerate },
    webSearchProvider: Object.assign(async () => ({ type: 'disabled' as const }), { alphaSearch: async () => config }),
    usageStore: { record: async row => { usage.push(row); } },
  } satisfies GatewayServices;
  return { receive, services, usage, enumerate };
};
