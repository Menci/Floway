import type { CandidateDiscoveryServices } from './discover-candidates.ts';
import type { GatewayHostServicesInput } from './host.ts';
import type { PerformanceServices } from './performance.ts';
import { getGatewayProviderServices, type GatewayProviderServices } from './provider-services.ts';
import type { RequestBodyService } from './request-body.ts';
import type { UsageStoreServices } from './store-usage.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import { createModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import { findCatalogCandidates } from '../providers/resolution.ts';
import { isAbortError, toProviderModelFact, type Fetcher, type ProviderServices, type ProviderUpstream, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';
import { azureUpstreamFact } from '@floway-dev/provider-azure';
import { chatgptUpstreamFact } from '@floway-dev/provider-chatgpt';
import { claudeCodeUpstreamFact } from '@floway-dev/provider-claude-code';
import { copilotUpstreamFact } from '@floway-dev/provider-copilot';
import { customUpstreamFact } from '@floway-dev/provider-custom';
import { kimiCodeUpstreamFact } from '@floway-dev/provider-kimi-code';
import { ollamaUpstreamFact } from '@floway-dev/provider-ollama';

export type GatewayServices = RequestBodyService & CandidateDiscoveryServices & PerformanceServices & UsageStoreServices
  & ProviderServices & GatewayProviderServices;

const projectUpstream = {
  azure: azureUpstreamFact,
  chatgpt: chatgptUpstreamFact,
  'claude-code': claudeCodeUpstreamFact,
  copilot: copilotUpstreamFact,
  custom: customUpstreamFact,
  'kimi-code': kimiCodeUpstreamFact,
  ollama: ollamaUpstreamFact,
} as const satisfies Record<UpstreamProviderKind, (record: UpstreamRecord) => ProviderUpstream>;

const asProviderFetcher = (resolve: () => Promise<(upstreamId: string) => Fetcher>): ProviderServices['fetcher'] =>
  id => async (url, init) => {
    const signal = init.signal;
    if (signal?.aborted) return { ok: false, error: { kind: 'abort', cause: signal.reason } };
    const fetch = (await resolve())(id);
    try {
      return { ok: true, value: await fetch(url, init) };
    } catch (error) {
      if (isAbortError(error)) return { ok: false, error: { kind: 'abort', cause: error } };
      if (!isUpstreamTransportError(error)) throw error;
      return { ok: false, error: { kind: signal?.aborted ? 'abort' : 'transport', cause: error } };
    }
  };

export const createGatewayServices = ({ requestBody, runtimeLocation }: GatewayHostServicesInput): GatewayServices => {
  const repo = getRepo();
  let upstreams: Promise<readonly StoredUpstreamRecord[]> | undefined;
  let fetcherResolver: Promise<(upstreamId: string) => Fetcher> | undefined;
  const listUpstreams = () => upstreams ??= repo.upstreams.list();
  const resolveFetcher = () => fetcherResolver ??= listUpstreams().then(rows => createPerRequestFetcher(runtimeLocation, rows));

  return {
    ...getGatewayProviderServices(),
    requestBody,
    runtimeLocation,
    fetcher: asProviderFetcher(resolveFetcher),
    async findCandidates(input, defer) {
      const { candidates, ...diagnostics } = await findCatalogCandidates(await listUpstreams(), {
        ...input,
        scheduleRefresh: createModelsRefreshScheduler(runtimeLocation, defer),
      });
      return {
        ...diagnostics,
        candidates: candidates.map(({ upstream, model, rules }) => ({
          upstream: projectUpstream[upstream.kind](upstream),
          model: toProviderModelFact(model),
          ...(rules === undefined ? {} : { rules }),
        })),
      };
    },
    async storeUsage(row) {
      await Promise.all([
        repo.usage.record(row),
        repo.apiKeys.update(row.keyId, { lastUsedAt: new Date().toISOString() }),
      ]);
    },
    performance: repo.performance,
  };
};
