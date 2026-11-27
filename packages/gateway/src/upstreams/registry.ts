import type { Fetcher, FlagDefaults, UpstreamKind, UpstreamModel, UpstreamModelConfig, UpstreamModule, UpstreamRecord, UpstreamScheduledOptions } from '@floway-dev/upstream';
import { azureUpstreamModule } from '@floway-dev/upstream-azure';
import { chatgptUpstreamModule } from '@floway-dev/upstream-chatgpt';
import { claudeCodeUpstreamModule } from '@floway-dev/upstream-claude-code';
import { copilotUpstreamModule } from '@floway-dev/upstream-copilot';
import { customUpstreamModule } from '@floway-dev/upstream-custom';
import { kimiCodeUpstreamModule } from '@floway-dev/upstream-kimi-code';
import { ollamaUpstreamModule } from '@floway-dev/upstream-ollama';

const upstreamsByKind: Record<UpstreamKind, UpstreamModule> = {
  copilot: copilotUpstreamModule,
  custom: customUpstreamModule,
  azure: azureUpstreamModule,
  chatgpt: chatgptUpstreamModule,
  'claude-code': claudeCodeUpstreamModule,
  'kimi-code': kimiCodeUpstreamModule,
  ollama: ollamaUpstreamModule,
};

export const flagDefaultsForKind = (kind: UpstreamKind): FlagDefaults =>
  upstreamsByKind[kind].defaultFlags;

export const getUpstreamModels = (
  record: UpstreamRecord,
  fetcher: Fetcher,
  manualModels: readonly UpstreamModelConfig[],
): Promise<readonly UpstreamModel[]> =>
  upstreamsByKind[record.kind].getModels(record, fetcher, manualModels);

export const runUpstreamScheduledTask = (
  record: UpstreamRecord,
  options: UpstreamScheduledOptions,
): Promise<void> =>
  upstreamsByKind[record.kind].runScheduledTask(record, options);
