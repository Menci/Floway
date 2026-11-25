import { isOllamaAccountProbeDue, refreshOllamaAccount } from './account-probe.ts';
import { assertOllamaUpstreamRecord } from './config.ts';
import { readOllamaUpstreamState } from './state.ts';
import { isOllamaUsageEnabled, isOllamaUsageProbeDue, refreshOllamaUsageProbe } from './usage-probe.ts';
import type { Result } from '@floway-dev/pipeline';
import type { ProviderRepo, ProviderServices } from '@floway-dev/provider';

export interface OllamaService {
  readonly refreshProbes: (upstreamId: string, fetcher: ReturnType<ProviderServices['fetcher']>) => Promise<Result<void, unknown>>;
}

export interface OllamaServices extends ProviderServices {
  readonly ollama: OllamaService;
}

export const createOllamaService = (repo: ProviderRepo): OllamaService => {
  const pending = new Map<string, ReturnType<OllamaService['refreshProbes']>>();

  const refresh: OllamaService['refreshProbes'] = async (upstreamId, fetcher) => {
    const record = await repo.upstreams.getById(upstreamId);
    if (record === null) return { ok: true, value: undefined };
    const { config, state: rawState } = assertOllamaUpstreamRecord(record);
    if (!isOllamaUsageEnabled(config)) return { ok: true, value: undefined };

    const state = readOllamaUpstreamState(rawState);
    const now = Date.now();
    const tasks: Promise<Result<unknown, unknown>>[] = [];
    if (isOllamaUsageProbeDue(state, now)) tasks.push(refreshOllamaUsageProbe(upstreamId, config, fetcher, repo, record.configVersion));
    if (isOllamaAccountProbeDue(state, now)) tasks.push(refreshOllamaAccount(upstreamId, config, fetcher, repo, record.configVersion));
    const failures = (await Promise.all(tasks)).filter(result => !result.ok);
    if (failures.length === 1) return failures[0];
    if (failures.length > 1) return { ok: false, error: new AggregateError(failures.map(failure => failure.error), 'Ollama usage and account probes failed') };
    return { ok: true, value: undefined };
  };

  return {
    refreshProbes(upstreamId, fetcher) {
      const running = pending.get(upstreamId);
      if (running) return running;
      const work = refresh(upstreamId, fetcher).finally(() => { pending.delete(upstreamId); });
      pending.set(upstreamId, work);
      return work;
    },
  };
};
