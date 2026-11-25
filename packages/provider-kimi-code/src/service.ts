import { assertKimiCodeUpstreamRecord } from './config.ts';
import { KIMI_CODE_ACCOUNT_INTERVAL_MS, KIMI_CODE_USAGE_INTERVAL_MS, probeKimiCodeAccount, probeKimiCodeUsage, type KimiCodeProbeFetcher } from './probe.ts';
import { readKimiCodeUpstreamState, type KimiCodeUpstreamState } from './state.ts';
import type { KimiCodeUpstreamFact } from './upstream-fact.ts';
import type { Result } from '@floway-dev/pipeline';
import { getProviderRepo, type ProviderServices } from '@floway-dev/provider';

type KimiCodePersistence =
  | { readonly persisted: true }
  | { readonly persisted: false; readonly error: unknown };

export interface KimiCodeService {
  readonly observeResponse: (upstream: KimiCodeUpstreamFact, status: number, fetcher: KimiCodeProbeFetcher) => Promise<KimiCodePersistence>;
}

export interface KimiCodeServices extends ProviderServices {
  readonly kimiCode: KimiCodeService;
}

export const createKimiCodeService = (): KimiCodeService => {
  const pending = new Map<string, Promise<Result<unknown, unknown>>>();

  const probe = (upstreamId: string, version: number, slot: keyof KimiCodeUpstreamState, refresh: () => Promise<Result<unknown, unknown>>): Promise<Result<unknown, unknown>> => {
    const key = JSON.stringify([upstreamId, version, slot]);
    const existing = pending.get(key);
    if (existing) return existing;
    const task = refresh().finally(() => { pending.delete(key); });
    pending.set(key, task);
    return task;
  };

  return {
    async observeResponse(upstream, status, fetcher) {
      const { upstreams } = getProviderRepo();
      let fresh;
      try {
        fresh = await upstreams.getById(upstream.id);
      } catch (error) {
        return { persisted: false, error };
      }
      if (fresh === null) return { persisted: true };
      const { region, apiKey } = upstream.config;
      const { config } = assertKimiCodeUpstreamRecord(fresh);
      if (config.region !== region || config.apiKey !== apiKey.reveal()) return { persisted: true };
      const { accountProbe, usageProbe } = readKimiCodeUpstreamState(fresh.state);
      const now = Date.now();
      const work: Promise<Result<unknown, unknown>>[] = [];
      // Quota exhaustion and plan restrictions warrant a current usage read.
      // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
      if (status === 429 || status === 403 || usageProbe === null || now - usageProbe.attemptedAt >= KIMI_CODE_USAGE_INTERVAL_MS) {
        work.push(probe(upstream.id, fresh.configVersion, 'usageProbe', () => probeKimiCodeUsage(upstream.id, config, fetcher)));
      }
      if (accountProbe === null || now - accountProbe.attemptedAt >= KIMI_CODE_ACCOUNT_INTERVAL_MS) {
        work.push(probe(upstream.id, fresh.configVersion, 'accountProbe', () => probeKimiCodeAccount(upstream.id, config, fetcher)));
      }
      const failures = (await Promise.all(work)).filter(result => !result.ok);
      if (failures.length > 0) return {
        persisted: false,
        error: new AggregateError(failures.map(failure => failure.error), 'Kimi Code request probes failed'),
      };
      return { persisted: true };
    },
  };
};
