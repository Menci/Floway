import type { CandidateDiscoveryServices } from './discover-candidates.ts';
import type { GatewayHostServicesInput } from './host.ts';
import type { PerformanceServices } from './performance.ts';
import { getGatewayProviderServices, type GatewayProviderServices } from './provider-services.ts';
import type { RequestBodyService } from './request-body.ts';
import type { UsageStoreServices } from './store-usage.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { adaptProviderFetcher } from '../../dial/transport-error.ts';
import { createModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { getRepo } from '../../repo/index.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import { createAffinityCodec, type AffinityCodec } from '../chat/shared/affinity/index.ts';
import { createSidecarCodecFactory, type SidecarCodecFactory } from '../chat/shared/sidecar-codec.ts';
import { findCatalogCandidates } from '../providers/resolution.ts';
import { toProviderModelFact, type Fetcher, type ProviderServices, type ProviderUpstream, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';
import { azureUpstreamFact } from '@floway-dev/provider-azure';
import { chatgptUpstreamFact } from '@floway-dev/provider-chatgpt';
import { claudeCodeUpstreamFact } from '@floway-dev/provider-claude-code';
import { copilotUpstreamFact } from '@floway-dev/provider-copilot';
import { customUpstreamFact } from '@floway-dev/provider-custom';
import { kimiCodeUpstreamFact } from '@floway-dev/provider-kimi-code';
import { ollamaUpstreamFact } from '@floway-dev/provider-ollama';

export type GatewayServices = RequestBodyService & CandidateDiscoveryServices & PerformanceServices & UsageStoreServices
  & ProviderServices & GatewayProviderServices & {
    readonly affinityCodec: () => AffinityCodec;
    readonly sidecarCodecFactory: SidecarCodecFactory;
  };

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
  id => adaptProviderFetcher(async () => (await resolve())(id));

export const createGatewayServices = ({ requestBody, runtimeLocation, serverSecret }: GatewayHostServicesInput): GatewayServices => {
  const repo = getRepo();
  let upstreams: Promise<readonly StoredUpstreamRecord[]> | undefined;
  let fetcherResolver: Promise<(upstreamId: string) => Fetcher> | undefined;
  const listUpstreams = () => upstreams ??= repo.upstreams.list();
  const resolveFetcher = () => fetcherResolver ??= listUpstreams().then(rows => createPerRequestFetcher(runtimeLocation, rows));
  let affinity: AffinityCodec | undefined;
  let sidecars: SidecarCodecFactory | undefined;

  return {
    ...getGatewayProviderServices(),
    requestBody,
    runtimeLocation,
    affinityCodec: () => affinity ??= createAffinityCodec(serverSecret),
    sidecarCodecFactory: {
      codecFor: domain => (sidecars ??= createSidecarCodecFactory(serverSecret)).codecFor(domain),
    },
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
