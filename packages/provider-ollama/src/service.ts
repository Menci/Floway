import { OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS, refreshOllamaAccount } from './account-probe.ts';
import { assertOllamaUpstreamRecord } from './config.ts';
import { readOllamaUpstreamState } from './state.ts';
import { isOllamaUsageEnabled, OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS, refreshOllamaUsageProbe } from './usage-probe.ts';
import { getProviderRepo, type Fetcher, type ProviderServices } from '@floway-dev/provider';

type Probe = 'usage' | 'account';
type ReportFailure = (probe: Probe, error: unknown) => void;

export interface OllamaService {
  refreshProbes(id: string, configVersion: number, fetcher: Fetcher, report: ReportFailure): Promise<void>;
}

export interface OllamaServices extends ProviderServices {
  ollama: OllamaService;
}

export const createOllamaService = (): OllamaService => {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    async refreshProbes(id, configVersion, fetcher, report) {
      const current = await getProviderRepo().upstreams.getById(id);
      if (current?.configVersion !== configVersion) return;
      const { config, state } = assertOllamaUpstreamRecord(current);
      if (!isOllamaUsageEnabled(config)) return;
      const { usageProbe, account } = readOllamaUpstreamState(state);
      const now = Date.now();
      const refresh = (probe: Probe, run: () => Promise<unknown>): Promise<unknown> => {
        const key = JSON.stringify([id, configVersion, probe]);
        const active = inFlight.get(key);
        if (active !== undefined) return active;
        const promise = run().catch((error: unknown) => report(probe, error)).finally(() => { inFlight.delete(key); });
        inFlight.set(key, promise);
        return promise;
      };

      await Promise.all([
        ...(usageProbe === null || now - usageProbe.attemptedAt >= OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS
          ? [refresh('usage', () => refreshOllamaUsageProbe(id, config, fetcher, configVersion))] : []),
        ...(account === null || now - account.fetchedAt >= OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS
          ? [refresh('account', () => refreshOllamaAccount(id, config, fetcher, configVersion))] : []),
      ]);
    },
  };
};
