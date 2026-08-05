import { getRepo } from '../../repo/index.ts';
import type { ModelsCacheGeneration } from '../../repo/types.ts';
import { serializeStoredConfig } from '../../repo/upstream-json.ts';
import type { FlagDefaults, Provider, ProviderModule, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { azureProviderModule } from '@floway-dev/provider-azure';
import { claudeCodeProviderModule } from '@floway-dev/provider-claude-code';
import { codexProviderModule } from '@floway-dev/provider-codex';
import { copilotProviderModule } from '@floway-dev/provider-copilot';
import { customProviderModule } from '@floway-dev/provider-custom';
import { ollamaProviderModule } from '@floway-dev/provider-ollama';

const providersByKind: Record<UpstreamProviderKind, ProviderModule> = {
  copilot: copilotProviderModule,
  custom: customProviderModule,
  azure: azureProviderModule,
  codex: codexProviderModule,
  'claude-code': claudeCodeProviderModule,
  ollama: ollamaProviderModule,
};

export type GatewayProvider = Provider & {
  readonly modelsCacheGeneration: ModelsCacheGeneration;
  readonly modelsFetchIdentity: string;
};

export const createProvider = (
  record: UpstreamRecord,
  cacheGeneration: ModelsCacheGeneration = { updatedAt: record.updatedAt, config: record.config },
): GatewayProvider => {
  const provider = providersByKind[record.kind].create(record);
  return {
    ...provider,
    modelsCacheGeneration: cacheGeneration,
    modelsFetchIdentity: serializeStoredConfig({
      kind: record.kind,
      config: record.config,
      state: record.state,
      proxyFallbackList: record.proxyFallbackList,
    }),
  };
};

export const flagDefaultsForKind = (kind: UpstreamProviderKind): FlagDefaults =>
  providersByKind[kind].defaultFlags;

// The upstream scope is a required argument across the catalog-assembly chain
// (this, `enumerateAddressableModelIds`, `enumerateModelCandidates`) so a
// caller can never omit it and silently receive the full, unscoped catalog —
// a missing scope is a compile error, not a runtime leak. Pass `null` to
// deliberately request every enabled upstream.
//
// `preFetchedUpstreams` lets a caller reuse a list it already loaded on
// this request instead of paying a second `upstreams.list()` round-trip.
export const listModelProviders = async (
  upstreamFilter: readonly string[] | null,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<GatewayProvider[]> => {
  const upstreams = preFetchedUpstreams ?? await getRepo().upstreams.list();
  const enabledById = new Map<string, UpstreamRecord>();
  for (const upstream of upstreams) {
    if (upstream.enabled) enabledById.set(upstream.id, upstream);
  }

  // The filter is the intersection of the per-user and per-api-key caps, both
  // of which reference upstreams by id. Deleting or disabling an upstream does
  // not prune those lists, so an id that no longer resolves is inert rather
  // than fatal: it narrows the scope and drops out on the next write to the
  // user or key. The principal keeps serving on the rest of its cap, and a
  // selection emptied this way surfaces downstream as "no upstream provider
  // configured".
  const selection = upstreamFilter
    ? upstreamFilter.map(id => enabledById.get(id)).filter((u): u is UpstreamRecord => u !== undefined)
    : [...enabledById.values()];

  return selection.map(record => createProvider(record));
};
