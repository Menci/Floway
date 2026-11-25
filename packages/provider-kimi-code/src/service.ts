import { assertKimiCodeUpstreamRecord } from './config.ts';
import { KIMI_CODE_ACCOUNT_PROBE_INTERVAL_MS, KIMI_CODE_USAGE_PROBE_INTERVAL_MS, refreshKimiCodeAccountProbe, refreshKimiCodeUsageProbe } from './probe.ts';
import { readKimiCodeUpstreamState } from './state.ts';
import { getProviderRepo, type Fetcher, type ProviderServices } from '@floway-dev/provider';

type Probe = 'usage' | 'account';
type ReportFailure = (probe: Probe, error: unknown) => void;

export interface KimiCodeService {
  refreshProbes(id: string, configVersion: number, fetcher: Fetcher, forceUsage: boolean, report: ReportFailure): Promise<void>;
}

export interface KimiCodeServices extends ProviderServices {
  kimiCode: KimiCodeService;
}

export const createKimiCodeService = (): KimiCodeService => {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    async refreshProbes(id, configVersion, fetcher, forceUsage, report) {
      const current = await getProviderRepo().upstreams.getById(id);
      if (current?.configVersion !== configVersion) return;
      const { config, state } = assertKimiCodeUpstreamRecord(current);
      const { usageProbe, accountProbe } = readKimiCodeUpstreamState(state);
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
        ...(forceUsage || usageProbe === null || now - usageProbe.attemptedAt >= KIMI_CODE_USAGE_PROBE_INTERVAL_MS
          ? [refresh('usage', () => refreshKimiCodeUsageProbe(id, config, fetcher, configVersion))] : []),
        ...(accountProbe === null || now - accountProbe.attemptedAt >= KIMI_CODE_ACCOUNT_PROBE_INTERVAL_MS
          ? [refresh('account', () => refreshKimiCodeAccountProbe(id, config, fetcher, configVersion))] : []),
      ]);
    },
  };
};
