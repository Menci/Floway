import { createPerRequestFetcher } from '../dial/per-request.ts';
import { adaptProviderFetcher } from '../dial/transport-error.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { ProviderScheduledOptions, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { runChatGPTScheduledTask } from '@floway-dev/provider-chatgpt';
import { runClaudeCodeScheduledTask } from '@floway-dev/provider-claude-code';
import { runCopilotScheduledTask } from '@floway-dev/provider-copilot';
import { runKimiCodeScheduledTask } from '@floway-dev/provider-kimi-code';
import { runOllamaScheduledTask } from '@floway-dev/provider-ollama';

const scheduledTasksByKind: Record<UpstreamProviderKind, ((record: UpstreamRecord, options: ProviderScheduledOptions) => Promise<void>) | null> = {
  azure: null,
  chatgpt: runChatGPTScheduledTask,
  'claude-code': runClaudeCodeScheduledTask,
  copilot: runCopilotScheduledTask,
  custom: null,
  'kimi-code': runKimiCodeScheduledTask,
  ollama: (record, options) => runOllamaScheduledTask(record, {
    async fetcher(fresh) {
      const fetcher = await options.fetcher(fresh);
      return fetcher === null ? null : adaptProviderFetcher(() => fetcher);
    },
  }),
};

export const runUpstreamScheduledTasks = async (runtimeLocation: string | null): Promise<void> => {
  const upstreams = await getRepo().upstreams.list();
  const failures: Error[] = [];
  await Promise.all(upstreams.map(async record => {
    try {
      await scheduledTasksByKind[record.kind]?.(record, {
        fetcher: async fresh => {
          if (runtimeLocation === null && !hasLocationIndependentEgress(fresh.proxyFallbackList)) return null;
          return (await createPerRequestFetcher(runtimeLocation, [fresh]))(fresh.id);
        },
      });
    } catch (cause) {
      failures.push(new Error(`Scheduled upstream task failed for ${record.id}`, { cause }));
    }
  }));
  if (failures.length > 0) throw new AggregateError(failures, 'Upstream scheduled tasks failed');
};
