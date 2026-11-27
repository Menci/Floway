import type { FlagDefaults } from './flags.ts';
import type { UpstreamModelConfig } from './model-config.ts';
import type { UpstreamModel, UpstreamRecord } from './model.ts';
import type { Fetcher } from './options.ts';
import type { UpstreamScheduledOptions } from './scheduled.ts';

export interface UpstreamModule {
  defaultFlags: FlagDefaults;
  getModels(record: UpstreamRecord, fetcher: Fetcher, manualModels?: readonly UpstreamModelConfig[]): Promise<readonly UpstreamModel[]>;
  runScheduledTask(record: UpstreamRecord, options: UpstreamScheduledOptions): Promise<void>;
}
