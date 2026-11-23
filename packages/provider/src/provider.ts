import type { FlagDefaults } from './flags.ts';
import type { ModelPrefixConfig } from './model-prefix.ts';
import type { ProviderModel, UpstreamModelsCache, UpstreamProviderKind, UpstreamRecord } from './model.ts';
import type { ProviderScheduledOptions } from './scheduled.ts';
import type { Fetcher } from '@floway-dev/http';

export interface Provider {
  upstreamId: string;
  kind: UpstreamProviderKind;
  name: string;
  disabledPublicModelIds: readonly string[];
  modelPrefix: ModelPrefixConfig | null;
  modelsCache: UpstreamModelsCache | null;
  instance: ProviderInstance;
}

export interface ProviderInstance {
  runScheduledTask(options: ProviderScheduledOptions): Promise<void>;
  getProvidedModels(fetcher: Fetcher): Promise<readonly ProviderModel[]>;
}

export interface ProviderModule {
  create: (record: UpstreamRecord) => Provider;
  defaultFlags: FlagDefaults;
}
