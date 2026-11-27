import { isOllamaAccountProbeDue, refreshOllamaAccount } from './account-probe.ts';
import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from './config.ts';
import { readOllamaUpstreamState, type OllamaUpstreamState } from './state.ts';
import { isOllamaUsageEnabled, isOllamaUsageProbeDue, refreshOllamaUsageProbe } from './usage-probe.ts';
import type { Fetcher, UpstreamHttpServices, UpstreamRuntimeRepo } from '@floway-dev/upstream';

export interface OllamaProbeTarget {
  readonly id: string;
  readonly config: Readonly<OllamaUpstreamConfig>;
}

export interface OllamaActiveUsageService {
  refreshUsage(upstream: OllamaProbeTarget, fetcher: Fetcher): Promise<void>;
  refreshAccount(upstream: OllamaProbeTarget, fetcher: Fetcher): Promise<void>;
}

export interface OllamaPipelineServices extends UpstreamHttpServices {
  ollama: OllamaActiveUsageService;
}

export const createOllamaActiveUsageService = (repo: UpstreamRuntimeRepo): OllamaActiveUsageService => {
  const active = new Set<string>();
  const refresh = async (
    { id, config }: OllamaProbeTarget,
    fetcher: Fetcher,
    probe: 'usage' | 'account',
    isDue: (state: OllamaUpstreamState, now: number) => boolean,
    run: typeof refreshOllamaUsageProbe | typeof refreshOllamaAccount,
  ): Promise<void> => {
    if (!isOllamaUsageEnabled(config)) return;
    const row = await repo.upstreams.getById(id);
    if (row === null) return;
    const { config: current, state } = assertOllamaUpstreamRecord(row);
    if (!current.cloudUsage || current.baseUrl !== config.baseUrl || current.apiKey !== config.apiKey) return;
    if (!isDue(readOllamaUpstreamState(state), Date.now())) return;
    const key = JSON.stringify([id, row.version, probe]);
    if (active.has(key)) return;
    active.add(key);
    try {
      await run(id, current, fetcher, { repo, version: row.version });
    } finally {
      active.delete(key);
    }
  };
  return {
    refreshUsage: (upstream, fetcher) => refresh(upstream, fetcher, 'usage', isOllamaUsageProbeDue, refreshOllamaUsageProbe),
    refreshAccount: (upstream, fetcher) => refresh(upstream, fetcher, 'account', isOllamaAccountProbeDue, refreshOllamaAccount),
  };
};
