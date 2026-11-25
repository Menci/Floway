import { isOllamaAccountProbeDue, refreshOllamaAccount } from './account-probe.ts';
import { assertOllamaUpstreamRecord } from './config.ts';
import { readOllamaUpstreamState } from './state.ts';
import { isOllamaUsageEnabled, isOllamaUsageProbeDue, refreshOllamaUsageProbe } from './usage-probe.ts';
import type { Fetcher, ProviderRepo, ProviderServices } from '@floway-dev/provider';

export interface OllamaService {
  readonly refreshProbes: (upstreamId: string, fetcher: Fetcher) => Promise<void>;
}

export interface OllamaServices extends ProviderServices {
  readonly ollama: OllamaService;
}

export const createOllamaService = (repo: ProviderRepo): OllamaService => {
  const pending = new Map<string, Promise<void>>();

  const refresh = async (upstreamId: string, fetcher: Fetcher): Promise<void> => {
    const record = await repo.upstreams.getById(upstreamId);
    if (record === null) return;
    const { config, state: rawState } = assertOllamaUpstreamRecord(record);
    if (!isOllamaUsageEnabled(config)) return;

    const state = readOllamaUpstreamState(rawState);
    const now = Date.now();
    const tasks: Promise<unknown>[] = [];
    if (isOllamaUsageProbeDue(state, now)) tasks.push(refreshOllamaUsageProbe(upstreamId, config, fetcher, repo, record.configVersion));
    if (isOllamaAccountProbeDue(state, now)) tasks.push(refreshOllamaAccount(upstreamId, config, fetcher, repo, record.configVersion));
    const failures = (await Promise.allSettled(tasks)).flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Ollama usage and account probes failed');
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
