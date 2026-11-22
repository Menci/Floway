import type { FlagDefaults } from './flags.ts';
import type { ModelPrefixConfig } from './model-prefix.ts';
import type { ProviderModel, UpstreamModelsCache, UpstreamProviderKind, UpstreamRecord } from './model.ts';
import type { Fetcher } from './options.ts';
import type { ProviderPipelines } from './pipeline.ts';
import type { ProviderScheduledOptions } from './scheduled.ts';

export type InboundHeaderMatcher = string | RegExp;

export interface Provider {
  upstreamId: string;
  kind: UpstreamProviderKind;
  name: string;
  pipelines: ProviderPipelines;
  // Client-authored headers this instance can consume. Strings are exact,
  // ASCII-case-insensitive names; regular expressions run against normalized
  // lowercase names. The gateway applies this at the candidate boundary.
  inboundHeaderAllowlist: readonly InboundHeaderMatcher[];
  disabledPublicModelIds: readonly string[];
  // Per-upstream model name prefix policy mirrored from the source upstream
  // record so registry helpers — routing and listing — read it from the
  // instance instead of re-fetching the row. `null` keeps the bare-id behavior.
  modelPrefix: ModelPrefixConfig | null;
  // The row's persisted catalog snapshot, mirrored so resolution does not pay
  // a second round trip after the row has already been loaded.
  modelsCache: UpstreamModelsCache | null;
  instance: ProviderInstance;
}

export interface ProviderInstance {
  runScheduledTask(options: ProviderScheduledOptions): Promise<void>;
  getProvidedModels(fetcher: Fetcher): Promise<readonly ProviderModel[]>;
}

// Static, module-shaped surface each provider package exports. The gateway
// registry keeps a Record<UpstreamProviderKind, ProviderModule> so every
// kind->X dispatch (instance construction, flag defaults) reads its answer
// off the same object.
export interface ProviderModule {
  create: (record: UpstreamRecord) => Provider;
  defaultFlags: FlagDefaults;
}
