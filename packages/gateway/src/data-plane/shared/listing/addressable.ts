// One enumeration per `upstreamIds` set of every inbound model id the
// gateway accepts — the union of the listed catalog surface and the
// addressable-but-not-listed surface contributed by `modelPrefix.addressable`
// alternates. Listing-side availability checks (this module's alias helper,
// codex catalog) must see the same set the request-time resolver routes
// through (the per-upstream walk inside `findCatalogCandidates`);
// recomputing it once here gives every consumer one consistent answer.
//
// Each entry carries the merged `InternalModel` the addressable id will
// route to, so consumers (alias intersection, codex catalog, control-plane
// DTO) read `limits` / `chat` / `endpoints` directly off the entry without
// a second registry round trip.

import { checkMany } from '../../../access-control/check.ts';
import type { ModelsRefreshScheduler } from '../../../execution/models-refresh.ts';
import { getRepo } from '../../../repo/index.ts';
import type { StoredUpstreamRecord, User } from '../../../repo/types.ts';
import { compareModelIds, getModelsFromUpstreams, mergeIntoCatalog } from '../../providers/catalog.ts';
import { MODEL_CATALOG_REVISION } from '../../providers/models-cache.ts';
import { selectEnabledUpstreams } from '../../providers/registry.ts';
import type { InternalModel } from '@floway-dev/provider';

export interface AddressableIdEntry {
  // The inbound model id the data plane will accept verbatim.
  readonly id: string;
  // Absent on default-listed entries (the public-id surface the listing
  // already emits); present-and-`true` on entries that are only reachable
  // through `modelPrefix.addressable` alternates. The negative carry pairs
  // with the `PublicModel.unlisted?: true` wire shape so a listed entry's
  // wire bytes stay byte-identical.
  readonly unlisted: true | undefined;
  // Real catalog row this id routes to. For multi-provider models this is
  // the same `InternalModel` that `getModelsFromUpstreams` returns (one row per
  // public-listed id, with the union-merged endpoints already applied).
  readonly model: InternalModel;
  // Every upstream that surfaces this addressable id in its
  // catalog, in enumeration order. Mirrors `upstreamsByPublicId` for the
  // canonical listed row the addressable id resolves to — addressable-only
  // alternates inherit the same list (the prefix-stripped id resolves
  // through the same upstream). Lets the control-plane DTO render per-
  // model upstream chips without re-walking the catalog.
  readonly upstreams: readonly StoredUpstreamRecord[];
}

// Project the listed (real-catalog) `InternalModel`s out of an addressable
// surface — every listing caller wants this same slice to feed
// `mergeAliasesIntoModels`'s `realModels` arg.
export const listedRealModels = (entries: readonly AddressableIdEntry[]): readonly InternalModel[] =>
  entries.filter(entry => entry.unlisted === undefined).map(entry => entry.model);

// Enumerate every inbound id the data plane accepts under `upstreamFilter`,
// tagged with whether the id participates in the default `/v1/models`
// listing.
export const enumerateAddressableModelIds = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
  scheduleRefresh: ModelsRefreshScheduler,
  preFetchedUpstreams?: readonly StoredUpstreamRecord[],
): Promise<readonly AddressableIdEntry[]> => {
  const selectedUpstreams = selectEnabledUpstreams(upstreamFilter, preFetchedUpstreams ?? await getRepo().upstreams.list());
  if (selectedUpstreams.length === 0) return [];
  const { models: realModels, upstreamsByPublicId } = getModelsFromUpstreams(selectedUpstreams, scheduleRefresh);
  const byId = new Map(realModels.map(model => [model.id, model] as const));

  const entries: AddressableIdEntry[] = [];
  const unlistedOnlyModels = new Map<string, InternalModel>();
  const unlistedOnlyUpstreams = new Map<string, StoredUpstreamRecord[]>();
  const seen = new Set<string>();
  const push = (entry: AddressableIdEntry): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };

  for (const model of realModels) {
    const upstreams = upstreamsByPublicId.get(model.id);
    if (upstreams === undefined) throw new Error(`Listed model ${model.id} has no upstream index`);
    push({ id: model.id, unlisted: undefined, model, upstreams });
  }

  // Prefix alternates reuse the persisted snapshots read by the listed surface.
  for (const upstream of selectedUpstreams) {
    const cfg = upstream.modelPrefix;
    const addressableOnly = cfg !== null ? cfg.addressable.filter(form => !cfg.listed.includes(form)) : [];
    if (cfg === null || addressableOnly.length === 0) continue;

    const upstreamModels = upstream.modelsCache?.revision === MODEL_CATALOG_REVISION ? upstream.modelsCache.models : [];
    const disabled = new Set(upstream.disabledPublicModelIds);

    // The canonical listed form for this upstream — the row the listing
    // surface emitted, and the row an addressable-only prefix alternate
    // resolves back into so consumers find one consistent `InternalModel`.
    const canonicalForm = cfg.listed.includes('prefixed') ? 'prefixed' : 'unprefixed';

    for (const upstreamModel of upstreamModels) {
      if (!upstreamModel.id || disabled.has(upstreamModel.id)) continue;
      if (cfg.listed.length === 0) {
        for (const form of addressableOnly) {
          const id = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
          mergeIntoCatalog(unlistedOnlyModels, unlistedOnlyUpstreams, upstream, upstreamModel, id);
        }
        continue;
      }
      const canonicalPublicId = canonicalForm === 'prefixed'
        ? `${cfg.prefix}${upstreamModel.id}`
        : upstreamModel.id;
      const canonical = byId.get(canonicalPublicId);
      if (canonical === undefined) throw new Error(`Addressable model ${canonicalPublicId} is missing from the listed catalog`);
      const canonicalUpstreams = upstreamsByPublicId.get(canonicalPublicId);
      if (canonicalUpstreams === undefined) throw new Error(`Addressable model ${canonicalPublicId} has no upstream index`);
      for (const form of addressableOnly) {
        const id = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
        push({ id, unlisted: true, model: canonical, upstreams: canonicalUpstreams });
      }
    }
  }

  for (const [id, model] of unlistedOnlyModels) {
    push({ id, unlisted: true, model, upstreams: unlistedOnlyUpstreams.get(id)! });
  }

  // Stable id ordering matches the listed surface so consumers can rely on
  // a single comparator across both halves.
  const checks = entries.flatMap(entry => entry.upstreams.map(upstream => ({
    entry,
    upstream,
    check: {
      target: { kind: 'upstreamModel' as const, upstreamId: upstream.id, model: { kind: 'exact' as const, value: entry.id } },
      requirement: { permission: 'Model.Use' as const },
    },
  })));
  const allowed = await checkMany(subject, checks.map(item => item.check));
  const allowedByEntry = new Map<AddressableIdEntry, StoredUpstreamRecord[]>();
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
    if (entry.model.providerModels === undefined) throw new Error(`Addressable real model ${entry.id} has no providerModels`);
    const rebuilt = new Map<string, InternalModel>();
    const rebuiltUpstreams = new Map<string, StoredUpstreamRecord[]>();
    for (const upstream of allowedUpstreams) {
      const providerModel = entry.model.providerModels[upstream.id];
      if (providerModel === undefined) throw new Error(`Addressable model ${entry.id} is missing provider data for ${upstream.id}`);
      mergeIntoCatalog(rebuilt, rebuiltUpstreams, upstream, providerModel, entry.model.id);
    }
    const model = rebuilt.get(entry.model.id);
    if (model === undefined) throw new Error(`Failed to rebuild authorized model ${entry.id}`);
    return [{ ...entry, model, upstreams: allowedUpstreams }];
  }).sort((a, b) => compareModelIds(a.id, b.id));
};
