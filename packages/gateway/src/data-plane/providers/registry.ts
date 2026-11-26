import { getRepo } from '../../repo/index.ts';
import { modelsRefreshInputHash } from '../../repo/models-refresh-inputs.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import type { FlagDefaults, ProviderUpstream, UpstreamProviderKind } from '@floway-dev/provider';
import { AZURE_DEFAULT_FLAGS, toAzureUpstream } from '@floway-dev/provider-azure';
import { CHATGPT_DEFAULT_FLAGS, toChatGPTUpstream } from '@floway-dev/provider-chatgpt';
import { CLAUDE_CODE_DEFAULT_FLAGS, toClaudeCodeUpstream } from '@floway-dev/provider-claude-code';
import { COPILOT_DEFAULT_FLAGS, copilotUpstreamFact } from '@floway-dev/provider-copilot';
import { CUSTOM_DEFAULT_FLAGS, toCustomUpstream } from '@floway-dev/provider-custom';
import { KIMI_CODE_DEFAULT_FLAGS, toKimiCodeUpstream } from '@floway-dev/provider-kimi-code';
import { OLLAMA_DEFAULT_FLAGS, toOllamaUpstream } from '@floway-dev/provider-ollama';

const providersByKind = {
  azure: { defaultFlags: AZURE_DEFAULT_FLAGS, toUpstream: toAzureUpstream },
  chatgpt: { defaultFlags: CHATGPT_DEFAULT_FLAGS, toUpstream: toChatGPTUpstream },
  'claude-code': { defaultFlags: CLAUDE_CODE_DEFAULT_FLAGS, toUpstream: toClaudeCodeUpstream },
  copilot: { defaultFlags: COPILOT_DEFAULT_FLAGS, toUpstream: copilotUpstreamFact },
  custom: { defaultFlags: CUSTOM_DEFAULT_FLAGS, toUpstream: toCustomUpstream },
  'kimi-code': { defaultFlags: KIMI_CODE_DEFAULT_FLAGS, toUpstream: toKimiCodeUpstream },
  ollama: { defaultFlags: OLLAMA_DEFAULT_FLAGS, toUpstream: toOllamaUpstream },
};

type CatalogFields = Pick<StoredUpstreamRecord, 'kind' | 'name' | 'modelPrefix' | 'disabledPublicModelIds' | 'modelsCache'>;

export interface GatewayProvider extends CatalogFields {
  readonly upstreamId: string;
  readonly record: StoredUpstreamRecord;
}

export const createProvider = (record: StoredUpstreamRecord): GatewayProvider => ({
  upstreamId: record.id,
  kind: record.kind,
  name: record.name,
  modelPrefix: record.modelPrefix,
  disabledPublicModelIds: record.disabledPublicModelIds,
  modelsCache: record.modelsCache,
  record,
});

export const toProviderUpstream = (record: StoredUpstreamRecord): ProviderUpstream =>
  providersByKind[record.kind].toUpstream(record);

export const providerRefreshTarget = ({ record }: GatewayProvider) => ({
  upstreamId: record.id,
  configVersion: record.configVersion,
  inputHash: modelsRefreshInputHash(record),
});

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
  preFetchedUpstreams?: readonly StoredUpstreamRecord[],
): Promise<GatewayProvider[]> => {
  const upstreams = preFetchedUpstreams ?? await getRepo().upstreams.list();
  const enabledById = new Map<string, StoredUpstreamRecord>();
  for (const upstream of upstreams) {
    if (upstream.enabled) enabledById.set(upstream.id, upstream);
  }

  // The filter is the intersection of the per-user and per-api-key caps, both
  // of which reference upstreams by id. Deleting or disabling an upstream does
  // not prune those lists, so an id that no longer resolves is inert rather
  // than fatal: it narrows the scope and drops out on the next write to the
  // user or key. The principal keeps serving on the rest of its cap; a
  // selection emptied this way is an empty catalog, not an error.
  const selection = upstreamFilter
    ? upstreamFilter.map(id => enabledById.get(id)).filter((u): u is StoredUpstreamRecord => u !== undefined)
    : [...enabledById.values()];

  return selection.map(record => createProvider(record));
};
