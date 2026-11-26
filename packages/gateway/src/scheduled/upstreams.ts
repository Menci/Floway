import { getProviderServices } from '../data-plane/pipeline/services.ts';
import { createPerRequestFetcher } from '../dial/per-request.ts';
import { getRepo } from '../repo/index.ts';
import { hasLocationIndependentEgress } from '../repo/proxy-fallback-list.ts';
import type { ProviderScheduledOptions, UpstreamRecord } from '@floway-dev/provider';
import { runChatGPTScheduledTask } from '@floway-dev/provider-chatgpt';
import { runClaudeCodeScheduledTask } from '@floway-dev/provider-claude-code';
import { runCopilotScheduledTask } from '@floway-dev/provider-copilot';
import { runKimiCodeScheduledTask } from '@floway-dev/provider-kimi-code';
import { runOllamaScheduledTask } from '@floway-dev/provider-ollama';

const runScheduledTask = (record: UpstreamRecord, options: ProviderScheduledOptions): Promise<void> => {
  const { claudeCode, chatgpt } = getProviderServices();
  switch (record.kind) {
  case 'chatgpt': return runChatGPTScheduledTask(record, options, chatgpt);
  case 'claude-code': return runClaudeCodeScheduledTask(record, options, claudeCode);
  case 'copilot': return runCopilotScheduledTask(record, options);
  case 'kimi-code': return runKimiCodeScheduledTask(record, options);
  case 'ollama': return runOllamaScheduledTask(record, options);
  case 'azure':
  case 'custom': return Promise.resolve();
  }
};

export const runUpstreamScheduledTasks = async (runtimeLocation: string | null): Promise<void> => {
  const upstreams = await getRepo().upstreams.list();
  const failures: Error[] = [];
  await Promise.all(upstreams.map(async record => {
    try {
      await runScheduledTask(record, {
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
