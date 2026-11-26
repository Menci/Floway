// One enumeration of every inbound model id the gateway accepts — the union of
// the listed catalog surface and the addressable-but-not-listed surface
// contributed by `modelPrefix.addressable` alternates. Listing-side
// availability checks (alias helper, Codex catalog, control-plane DTO) read
// directly from the `upstream_models` table plus lightweight upstream metadata
// without loading `config_json` / `state_json` or instantiating `Provider`s.

import { checkMany } from '../../../access-control/check.ts';
import { getRepo } from '../../../repo/index.ts';
import type { CatalogModelEntry, CatalogUpstreamRow, User } from '../../../repo/types.ts';
import {
  compareModelIds,
  createCatalogAccumulator,
  distinctUpstreamsFromContributions,
  mergeIntoCatalog,
  type CatalogUpstreamMeta,
  type ModelContribution,
} from '../../providers/catalog.ts';
import type { InternalModel, ProviderModel } from '@floway-dev/provider';

export interface AddressableIdEntry {
  // The inbound model id the data plane will accept verbatim.
  readonly id: string;
  // Absent on default-listed entries; `true` on entries only reachable through
  // `modelPrefix.addressable` alternates.
  readonly unlisted: true | undefined;
  // Real catalog row this id routes to, with union-merged endpoints across all
  // contributing upstreams.
  readonly model: InternalModel;
  // Every upstream that surfaces this addressable id, in enumeration order.
  readonly upstreams: readonly CatalogUpstreamMeta[];
  // Per-upstream raw ProviderModel contributions (preserving multi-kind rows
  // on the same upstream) for downstream consumers such as Codex synthesis.
  readonly contributions: readonly ModelContribution[];
}

// Project the listed (real-catalog) `InternalModel`s out of an addressable
// surface — every listing caller wants this same slice to feed
// `mergeAliasesIntoModels`'s `realModels` arg.
export const listedRealModels = (entries: readonly AddressableIdEntry[]): readonly InternalModel[] =>
  entries.filter(entry => entry.unlisted === undefined).map(entry => entry.model);

const toUpstreamMeta = (row: CatalogUpstreamRow): CatalogUpstreamMeta => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  hue: row.hue,
});

const assembleAddressableEntries = (
  upstreams: readonly CatalogUpstreamRow[],
  models: readonly CatalogModelEntry[],
): AddressableIdEntry[] => {
  const modelsByUpstream = new Map<string, ProviderModel[]>();
  for (const { upstreamId, model } of models) {
    let list = modelsByUpstream.get(upstreamId);
    if (list === undefined) {
      list = [];
      modelsByUpstream.set(upstreamId, list);
    }
    list.push(model);
  }

  const acc = createCatalogAccumulator();
  const listedIds = new Set<string>();

  for (const upstream of upstreams) {
    const meta = toUpstreamMeta(upstream);
    const cfg = upstream.modelPrefix;
    const forms = cfg === null ? (['unprefixed'] as const) : cfg.addressable;
    for (const providerModel of modelsByUpstream.get(upstream.id) ?? []) {
      if (!providerModel.id) continue;
      for (const form of forms) {
        const publicId = form === 'prefixed' ? `${cfg!.prefix}${providerModel.id}` : providerModel.id;
        if (cfg === null || cfg.listed.includes(form)) listedIds.add(publicId);
        const surfacedModel: ProviderModel = form === 'prefixed'
          ? { ...providerModel, id: publicId, display_name: `${upstream.name}: ${providerModel.display_name ?? providerModel.id}` }
          : providerModel;
        mergeIntoCatalog(acc, meta, surfacedModel, publicId);
      }
    }
  }

  const entries: AddressableIdEntry[] = [];
  for (const [id, model] of acc.byId) {
    const contributions = acc.contributionsById.get(id)!;
    entries.push({
      id,
      unlisted: listedIds.has(id) ? undefined : true,
      model,
      upstreams: distinctUpstreamsFromContributions(contributions),
      contributions,
    });
  }
  entries.sort((a, b) => compareModelIds(a.id, b.id));
  return entries;
};

const filterAuthorizedEntries = async (
  subject: User,
  entries: readonly AddressableIdEntry[],
): Promise<readonly AddressableIdEntry[]> => {
  if (entries.length === 0 || subject.isAdmin) return entries;

  const checks = entries.flatMap(entry => entry.upstreams.map(upstream => ({
    entry,
    upstream,
    check: {
      target: { kind: 'upstreamModel' as const, upstreamId: upstream.id, model: { kind: 'exact' as const, value: entry.id } },
      requirement: { permission: 'Model.Use' as const },
    },
  })));
  const allowed = await checkMany(subject, checks.map(item => item.check));
  const allowedUpstreamIdsByEntry = new Map<AddressableIdEntry, Set<string>>();
  for (let index = 0; index < checks.length; index++) {
    if (!allowed[index]) continue;
    const item = checks[index]!;
    let set = allowedUpstreamIdsByEntry.get(item.entry);
    if (set === undefined) {
      set = new Set();
      allowedUpstreamIdsByEntry.set(item.entry, set);
    }
    set.add(item.upstream.id);
  }

  return entries.flatMap(entry => {
    const allowedIds = allowedUpstreamIdsByEntry.get(entry);
    if (allowedIds === undefined || allowedIds.size === 0) return [];
    const allowedContributions = entry.contributions.filter(c => allowedIds.has(c.upstream.id));
    const rebuilt = createCatalogAccumulator();
    for (const contribution of allowedContributions) {
      mergeIntoCatalog(rebuilt, contribution.upstream, contribution.model, entry.id);
    }
    return [{
      id: entry.id,
      unlisted: entry.unlisted,
      model: rebuilt.byId.get(entry.id)!,
      upstreams: distinctUpstreamsFromContributions(allowedContributions),
      contributions: allowedContributions,
    }];
  });
};

// Load both caller-scoped and gateway-wide addressable surfaces from one DB
// catalog read. When the caller is an unrestricted admin, both surfaces are the
// same array.
export const loadAddressableSurfaces = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
): Promise<{
  readonly callerAddressable: readonly AddressableIdEntry[];
  readonly gatewayAddressable: readonly AddressableIdEntry[];
}> => {
  const { upstreams: allUpstreams, models: allModels } = await getRepo().upstreamModels.listCatalog(null);
  const gatewayAddressable = assembleAddressableEntries(allUpstreams, allModels);
  if (subject.isAdmin && upstreamFilter === null) {
    return { callerAddressable: gatewayAddressable, gatewayAddressable };
  }

  let callerRaw: readonly AddressableIdEntry[];
  if (upstreamFilter === null) {
    callerRaw = gatewayAddressable;
  } else if (upstreamFilter.length === 0) {
    callerRaw = [];
  } else {
    const byId = new Map(allUpstreams.map(u => [u.id, u] as const));
    const scopedUpstreams = upstreamFilter
      .map(id => byId.get(id))
      .filter((u): u is CatalogUpstreamRow => u !== undefined);
    const scopedIds = new Set(scopedUpstreams.map(u => u.id));
    const scopedModels = allModels.filter(m => scopedIds.has(m.upstreamId));
    callerRaw = assembleAddressableEntries(scopedUpstreams, scopedModels);
  }

  const callerAddressable = await filterAuthorizedEntries(subject, callerRaw);
  return { callerAddressable, gatewayAddressable };
};

export const enumerateAddressableModelIds = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
): Promise<readonly AddressableIdEntry[]> => {
  const { upstreams, models } = await getRepo().upstreamModels.listCatalog(upstreamFilter);
  const raw = assembleAddressableEntries(upstreams, models);
  return await filterAuthorizedEntries(subject, raw);
};
