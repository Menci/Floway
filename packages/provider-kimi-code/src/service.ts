import type { KimiCodeUpstreamFacts } from './config.ts';
import { isKimiCodeAccountProbeDue, isKimiCodeUsageProbeDue, refreshKimiCodeAccountProbe, refreshKimiCodeUsageProbe } from './probe.ts';
import { readKimiCodeUpstreamState } from './state.ts';
import { getProviderRepo, type Fetcher, type ProviderServices } from '@floway-dev/provider';

interface ProbeWork {
  readonly kind: 'usage' | 'account';
  readonly work: Promise<unknown>;
}

export interface KimiCodeService {
  readonly probeAfterResponse: (upstream: KimiCodeUpstreamFacts, status: number, fetcher: Fetcher) => Promise<readonly ProbeWork[]>;
}

export type KimiCodeServices = ProviderServices & { readonly kimiCode: KimiCodeService };

export const createKimiCodeService = (): KimiCodeService => ({
  async probeAfterResponse({ id, config }, status, fetcher) {
    const saved = await getProviderRepo().upstreams.getById(id);
    if (saved === null) return [];
    const state = readKimiCodeUpstreamState(saved.state);
    const now = Date.now();
    const probeConfig = { region: config.region, apiKey: config.apiKey.reveal() };
    const probes: ProbeWork[] = [];
    // Quota exhaustion and plan restrictions warrant a current usage reading.
    // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
    if (status === 429 || status === 403 || isKimiCodeUsageProbeDue(state, now)) {
      probes.push({ kind: 'usage', work: refreshKimiCodeUsageProbe(id, probeConfig, fetcher) });
    }
    if (isKimiCodeAccountProbeDue(state, now)) {
      probes.push({ kind: 'account', work: refreshKimiCodeAccountProbe(id, probeConfig, fetcher) });
    }
    return probes;
  },
});
