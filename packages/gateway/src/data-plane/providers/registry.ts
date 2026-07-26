import { getRepo } from '../../repo/index.ts';
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

export const createProvider = (record: UpstreamRecord): Provider =>
  providersByKind[record.kind].create(record);

export const flagDefaultsForKind = (kind: UpstreamProviderKind): FlagDefaults =>
  providersByKind[kind].defaultFlags;

// The upstream scope is a required argument across the provider-listing boundary
// this so a caller can never omit it and silently receive the
// full, unscoped catalog — a missing scope is a compile error, not a runtime
// leak. Pass `null` to deliberately request every enabled upstream.
//
// `preFetchedUpstreams` lets a caller reuse a list it already loaded on
// this request instead of paying a second `upstreams.list()` round-trip.
export const listModelProviders = async (
  upstreamFilter: readonly string[] | null,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<Provider[]> => {
  const upstreams = preFetchedUpstreams ?? await getRepo().upstreams.list();
  const enabledById = new Map<string, UpstreamRecord>();
  const knownIds = new Set<string>();
  for (const upstream of upstreams) {
    knownIds.add(upstream.id);
    if (upstream.enabled) enabledById.set(upstream.id, upstream);
  }

  let selection: UpstreamRecord[];
  if (upstreamFilter) {
    // Unknown ids are a caller-side configuration error (the filter is the
    // intersection of per-user + per-api-key caps; both reference upstreams
    // by id); surface them so the operator notices instead of silently
    // serving a smaller subset. Disabled-but-known ids stay silent: a user
    // cap may legitimately mention an upstream the operator just disabled.
    const unknown = upstreamFilter.filter(id => !knownIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown upstream id(s) in filter: ${unknown.join(', ')}`);
    }
    selection = upstreamFilter
      .map(id => enabledById.get(id))
      .filter((u): u is UpstreamRecord => u !== undefined);
  } else {
    selection = [...enabledById.values()];
  }

  return selection.map(createProvider);
};
