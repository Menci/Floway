// One enumeration of every inbound model id the gateway accepts — the union of
// the listed catalog surface and the addressable-but-not-listed surface
// contributed by `modelPrefix.addressable` alternates. Listing-side
// availability checks (alias helper, Codex catalog, control-plane DTO) read
// directly from the `upstream_models` table plus lightweight upstream metadata
// without loading `config_json` / `state_json` or instantiating `Provider`s.

import { checkMany } from '../../../access-control/check.ts';
import { getRepo } from '../../../repo/index.ts';
import type { CatalogModelEntry, CatalogUpstreamRow, User } from '../../../repo/types.ts';
import { compareModelIds, createCatalogAccumulator, mergeIntoCatalog, type CatalogUpstreamMeta } from '../../providers/catalog.ts';
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
}

interface RawAddressableEntry extends AddressableIdEntry {
  readonly contributions: ReadonlyMap<string, readonly ProviderModel[]>;
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

const assembleRawAddressableEntries = (
  upstreams: readonly CatalogUpstreamRow[],
  models: readonly CatalogModelEntry[],
): RawAddressableEntry[] => {
  const modelsByUpstream = new Map<string, ProviderModel[]>();
  for (const { upstreamId, model } of models) {
    let list = modelsByUpstream.get(upstreamId);
    if (list === undefined) {
      list = [];
      modelsByUpstream.set(upstreamId, list);
    }
    list.push(model);
  }

  const listedAcc = createCatalogAccumulator();
  for (const upstream of upstreams) {
    const meta = toUpstreamMeta(upstream);
    const disabled = new Set(upstream.disabledPublicModelIds);
    const upstreamModels = modelsByUpstream.get(upstream.id) ?? [];
    for (const providerModel of upstreamModels) {
      if (!providerModel.id || disabled.has(providerModel.id)) continue;
      const cfg = upstream.modelPrefix;
      if (cfg !== null) {
        for (const form of cfg.listed) {
          const publicId = form === 'prefixed' ? `${cfg.prefix}${providerModel.id}` : providerModel.id;
          const surfacedModel: ProviderModel = form === 'prefixed'
            ? { ...providerModel, id: publicId, display_name: `${upstream.name}: ${providerModel.display_name ?? providerModel.id}` }
            : providerModel;
          mergeIntoCatalog(listedAcc, meta, surfacedModel, publicId);
        }
      } else {
        mergeIntoCatalog(listedAcc, meta, providerModel, providerModel.id);
      }
    }
  }

  const entries: RawAddressableEntry[] = [];
  const unlistedAcc = createCatalogAccumulator();
  const seen = new Set<string>();
  const push = (entry: RawAddressableEntry): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };

  for (const model of listedAcc.byId.values()) {
    const contributing = listedAcc.upstreamsByPublicId.get(model.id);
    const contributions = listedAcc.contributionsByPublicId.get(model.id);
    if (contributing === undefined || contributions === undefined) {
      throw new Error(`Listed model ${model.id} has no upstream index`);
    }
    push({ id: model.id, unlisted: undefined, model, upstreams: contributing, contributions });
  }

  for (const upstream of upstreams) {
    const cfg = upstream.modelPrefix;
    const addressableOnly = cfg !== null ? cfg.addressable.filter(form => !cfg.listed.includes(form)) : [];
    if (cfg === null || addressableOnly.length === 0) continue;

    const meta = toUpstreamMeta(upstream);
    const disabled = new Set(upstream.disabledPublicModelIds);
    const upstreamModels = modelsByUpstream.get(upstream.id) ?? [];
    const canonicalForm = cfg.listed.includes('prefixed') ? 'prefixed' : 'unprefixed';

    for (const upstreamModel of upstreamModels) {
      if (!upstreamModel.id || disabled.has(upstreamModel.id)) continue;
      if (cfg.listed.length === 0) {
        for (const form of addressableOnly) {
          const id = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
          mergeIntoCatalog(unlistedAcc, meta, upstreamModel, id);
        }
        continue;
      }
      const canonicalPublicId = canonicalForm === 'prefixed'
        ? `${cfg.prefix}${upstreamModel.id}`
        : upstreamModel.id;
      const canonical = listedAcc.byId.get(canonicalPublicId);
      const canonicalUpstreams = listedAcc.upstreamsByPublicId.get(canonicalPublicId);
      const canonicalContributions = listedAcc.contributionsByPublicId.get(canonicalPublicId);
      if (canonical === undefined || canonicalUpstreams === undefined || canonicalContributions === undefined) {
        throw new Error(`Addressable model ${canonicalPublicId} is missing from the listed catalog`);
      }
      for (const form of addressableOnly) {
        const id = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
        push({
          id,
          unlisted: true,
          model: canonical,
          upstreams: canonicalUpstreams,
          contributions: canonicalContributions,
        });
      }
    }
  }

  for (const [id, model] of unlistedAcc.byId) {
    push({
      id,
      unlisted: true,
      model,
      upstreams: unlistedAcc.upstreamsByPublicId.get(id)!,
      contributions: unlistedAcc.contributionsByPublicId.get(id)!,
    });
  }

  return entries;
};

const filterAuthorizedEntries = async (
  subject: User,
  entries: readonly RawAddressableEntry[],
): Promise<readonly AddressableIdEntry[]> => {
  if (entries.length === 0) return [];
  if (subject.isAdmin) {
    return entries
      .map(({ contributions: _contributions, ...entry }) => entry)
      .sort((a, b) => compareModelIds(a.id, b.id));
  }

  const checks = entries.flatMap(entry => entry.upstreams.map(upstream => ({
    entry,
    upstream,
    check: {
      target: { kind: 'upstreamModel' as const, upstreamId: upstream.id, model: { kind: 'exact' as const, value: entry.id } },
      requirement: { permission: 'Model.Use' as const },
    },
  })));
  const allowed = await checkMany(subject, checks.map(item => item.check));
  const allowedByEntry = new Map<RawAddressableEntry, CatalogUpstreamMeta[]>();
  for (let index = 0; index < checks.length; index++) {
    if (!allowed[index]) continue;
    const item = checks[index]!;
    const current = allowedByEntry.get(item.entry);
    if (current) current.push(item.upstream);
    else allowedByEntry.set(item.entry, [item.upstream]);
  }

  return entries.flatMap(entry => {
    const allowedUpstreams = allowedByEntry.get(entry);
    if (!allowedUpstreams?.length) return [];
    const rebuilt = createCatalogAccumulator();
    for (const upstream of allowedUpstreams) {
      const contributed = entry.contributions.get(upstream.id);
      if (contributed === undefined || contributed.length === 0) {
        throw new Error(`Addressable model ${entry.id} is missing provider data for ${upstream.id}`);
      }
      for (const providerModel of contributed) {
        mergeIntoCatalog(rebuilt, upstream, providerModel, entry.model.id);
      }
    }
    const model = rebuilt.byId.get(entry.model.id);
    if (model === undefined) throw new Error(`Failed to rebuild authorized model ${entry.id}`);
    return [{
      id: entry.id,
      unlisted: entry.unlisted,
      model,
      upstreams: allowedUpstreams,
    }];
  }).sort((a, b) => compareModelIds(a.id, b.id));
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
  const gatewayRaw = assembleRawAddressableEntries(allUpstreams, allModels);
  if (subject.isAdmin && upstreamFilter === null) {
    const sorted = gatewayRaw
      .map(({ contributions: _contributions, ...entry }) => entry)
      .sort((a, b) => compareModelIds(a.id, b.id));
    return { callerAddressable: sorted, gatewayAddressable: sorted };
  }

  let callerRaw: readonly RawAddressableEntry[];
  if (upstreamFilter === null) {
    callerRaw = gatewayRaw;
  } else if (upstreamFilter.length === 0) {
    callerRaw = [];
  } else {
    const byId = new Map(allUpstreams.map(u => [u.id, u] as const));
    const scopedUpstreams = upstreamFilter
      .map(id => byId.get(id))
      .filter((u): u is CatalogUpstreamRow => u !== undefined);
    const scopedIds = new Set(scopedUpstreams.map(u => u.id));
    const scopedModels = allModels.filter(m => scopedIds.has(m.upstreamId));
    callerRaw = assembleRawAddressableEntries(scopedUpstreams, scopedModels);
  }

  const gatewayAddressable = gatewayRaw
    .map(({ contributions: _contributions, ...entry }) => entry)
    .sort((a, b) => compareModelIds(a.id, b.id));
  const callerAddressable = await filterAuthorizedEntries(subject, callerRaw);
  return { callerAddressable, gatewayAddressable };
};

export const enumerateAddressableModelIds = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
): Promise<readonly AddressableIdEntry[]> => {
  const { upstreams, models } = await getRepo().upstreamModels.listCatalog(upstreamFilter);
  if (upstreams.length === 0 && upstreamFilter !== null) return [];
  const raw = assembleRawAddressableEntries(upstreams, models);
  return await filterAuthorizedEntries(subject, raw);
};
