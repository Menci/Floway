import { isOllamaAccountProbeDue, refreshOllamaAccount } from './account-probe.ts';
import type { OllamaUpstreamFacts } from './config.ts';
import { readOllamaUpstreamState } from './state.ts';
import { isOllamaUsageEnabled, isOllamaUsageProbeDue, refreshOllamaUsageProbe } from './usage-probe.ts';
import { snapshotError, type ErrorSnapshot } from '@floway-dev/pipeline';
import { getProviderRepo, type Fetcher, type ProviderServices } from '@floway-dev/provider';

type ProbeResult = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };
type Probes = {
  readonly usage?: Promise<ProbeResult>;
  readonly account?: Promise<ProbeResult>;
};

export interface OllamaService {
  readonly probeAfterResponse: (upstream: OllamaUpstreamFacts, fetcher: Fetcher) => Promise<Probes>;
}

export type OllamaServices = ProviderServices & { readonly ollama: OllamaService };

const probeResult = (work: Promise<unknown>): Promise<ProbeResult> => work.then<ProbeResult, ProbeResult>(
  () => ({ persisted: true }),
  (error: unknown) => ({ persisted: false, error: snapshotError(error) }),
);

export const createOllamaService = (): OllamaService => ({
  async probeAfterResponse({ id, config }, fetcher) {
    if (!isOllamaUsageEnabled(config)) return {};
    const record = await getProviderRepo().upstreams.getById(id);
    if (record === null) return {};
    const state = readOllamaUpstreamState(record.state);
    const now = Date.now();
    return {
      ...(isOllamaUsageProbeDue(state, now) ? { usage: probeResult(refreshOllamaUsageProbe(id, config, fetcher)) } : {}),
      ...(isOllamaAccountProbeDue(state, now) ? { account: probeResult(refreshOllamaAccount(id, config, fetcher)) } : {}),
    };
  },
});
