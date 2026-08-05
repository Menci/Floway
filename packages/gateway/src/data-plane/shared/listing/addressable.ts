// One enumeration per `upstreamIds` set of every inbound model id the
// gateway accepts — the union of the listed catalog surface and the
// addressable-but-not-listed surface contributed by `modelPrefix.addressable`
// alternates. Listing-side availability checks (this module's alias helper,
// codex catalog) must see the same set the request-time resolver routes
// through (the per-upstream walk inside `enumerateRealModelCandidates`);
// recomputing it once here gives every consumer one consistent answer.
//
// Each entry carries the merged `InternalModel` the addressable id will
// route to, so consumers (alias intersection, codex catalog, control-plane
// DTO) read `limits` / `chat` / `endpoints` directly off the entry without
// a second registry round trip.

import { compareModelIds, getModelsFromProviders, internalModelFromProviderModel, mergeRealModels } from '../../providers/catalog.ts';
import { settleCatalogTasks } from '../../providers/catalog-settlement.ts';
import { fetchUpstreamModelsCached } from '../../providers/models-cache.ts';
import { listModelProviders } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher, InternalModel, Provider, UpstreamRecord } from '@floway-dev/provider';

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
  // the same `InternalModel` instance `getModelsFromProviders` returns (one row per
  // public-listed id, with the union-merged endpoints already applied).
  readonly model: InternalModel;
  // Every upstream instance that surfaces this addressable id in its
  // catalog, in enumeration order. Mirrors `upstreamsByPublicId` for the
  // canonical listed row the addressable id resolves to — addressable-only
  // alternates inherit the same list (the prefix-stripped id resolves
  // through the same upstream). Lets the control-plane DTO render per-
  // model upstream chips without re-walking the catalog.
  readonly upstreams: readonly Provider[];
}

// Project the listed (real-catalog) `InternalModel`s out of an addressable
// surface — every listing caller wants this same slice to feed
// `mergeAliasesIntoModels`'s `realModels` arg.
export const listedRealModels = (entries: readonly AddressableIdEntry[]): readonly InternalModel[] =>
  entries.filter(entry => entry.unlisted === undefined).map(entry => entry.model);

const mergeUpstreams = (first: readonly Provider[], later: readonly Provider[]): Provider[] => {
  const merged: Provider[] = [];
  const seen = new Set<string>();
  for (const upstream of [...first, ...later]) {
    if (seen.has(upstream.upstreamId)) continue;
    seen.add(upstream.upstreamId);
    merged.push(upstream);
  }
  return merged;
};

const mergeAddressableEntries = (first: AddressableIdEntry, later: AddressableIdEntry): AddressableIdEntry => ({
  id: first.id,
  // A listed contribution keeps the merged id listed even when another
  // upstream contributes the same id only as an addressable alternate.
  unlisted: first.unlisted === undefined || later.unlisted === undefined ? undefined : true,
  model: mergeRealModels(first.model, later.model),
  upstreams: mergeUpstreams(first.upstreams, later.upstreams),
});

// Enumerate every inbound id the data plane accepts under `upstreamFilter`,
// tagged with whether the id participates in the default `/v1/models`
// listing. Fans out per upstream the same way `collectProviderModels` does,
// re-uses the SWR cache so the catalog refresh round-trip is shared with
// `getModelsFromProviders`.
export const enumerateAddressableModelIds = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  preFetchedUpstreams?: readonly UpstreamRecord[],
): Promise<readonly AddressableIdEntry[]> => {
  // Resolve providers once and thread them into the catalog assembly so
  // the upstreams.list() round-trip and provider-instantiation cost is
  // paid once per call. `getModelsFromProviders` throws the actionable
  // "no upstream provider configured" message when the provider list is
  // empty; surface it the same way here so /v1/models keeps its 502 +
  // hint behavior on a brand-new gateway. `preFetchedUpstreams` avoids
  // an additional round-trip when the caller has the list already.
  const providers = await listModelProviders(upstreamFilter, preFetchedUpstreams);
  const { models: realModels, upstreamsByPublicId } = await getModelsFromProviders(providers, fetcherForUpstream, scheduler);
  const byId = new Map(realModels.map(model => [model.id, model] as const));

  const entries: AddressableIdEntry[] = [];
  const indexById = new Map<string, number>();
  const push = (entry: AddressableIdEntry): void => {
    const existingIndex = indexById.get(entry.id);
    if (existingIndex !== undefined) {
      entries[existingIndex] = mergeAddressableEntries(entries[existingIndex], entry);
      return;
    }
    indexById.set(entry.id, entries.length);
    entries.push(entry);
  };

  for (const model of realModels) {
    push({ id: model.id, unlisted: undefined, model, upstreams: upstreamsByPublicId.get(model.id) ?? [] });
  }

  // Per-upstream walk for the prefix-addressable alternates the listed
  // surface chose not to publish. The catalog round-trip is the same SWR
  // cache the listed surface just consumed, so this loop never pays a
  // second upstream hit.
  //
  // A rejected per-upstream catalog refresh collapses to no addressable-
  // only contribution from THAT upstream — its listed rows already came
  // (or were dropped) through `getModelsFromProviders`. Ordinary failures
  // remain isolated while caller cancellation rejects the whole fanout.
  const perUpstream = await settleCatalogTasks(providers.map(provider => async () => {
    const cfg = provider.modelPrefix;
    const addressableOnly = cfg !== null ? cfg.addressable.filter(form => !cfg.listed.includes(form)) : [];
    if (cfg === null || addressableOnly.length === 0) return [] as AddressableIdEntry[];

    const upstreamModels = await fetchUpstreamModelsCached(provider, { scheduler, fetcher: fetcherForUpstream(provider.upstreamId) });
    const disabled = new Set(provider.disabledPublicModelIds);
    const out: AddressableIdEntry[] = [];

    // The canonical listed form for this upstream — the row the listing
    // surface emitted, and the row an addressable-only prefix alternate
    // resolves back into so consumers find one consistent `InternalModel`.
    const canonicalForm = cfg.listed.includes('prefixed') ? 'prefixed' : 'unprefixed';

    for (const upstreamModel of upstreamModels) {
      if (!upstreamModel.id || disabled.has(upstreamModel.id)) continue;
      const canonicalPublicId = canonicalForm === 'prefixed'
        ? `${cfg.prefix}${upstreamModel.id}`
        : upstreamModel.id;
      const canonical = byId.get(canonicalPublicId);
      if (canonical === undefined) continue;
      if (canonical.providerModels === undefined) {
        throw new Error(`addressable catalog row for '${canonicalPublicId}' unexpectedly carries aliasedFrom`);
      }
      const providerModel = canonical.providerModels[provider.upstreamId];
      if (providerModel === undefined) {
        throw new Error(`addressable catalog row for '${canonicalPublicId}' is missing upstream ${provider.upstreamId}`);
      }
      // A canonical listed row may merge other upstreams that do not accept
      // this alternate form. Narrow the contribution to the provider whose
      // prefix policy proved the alternate addressable; later contributions
      // under the same inbound id are merged by `push`.
      const addressableModel = Object.keys(canonical.providerModels).length === 1
        ? canonical
        : internalModelFromProviderModel(providerModel, provider.upstreamId);
      for (const form of addressableOnly) {
        const id = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
        out.push({ id, unlisted: true, model: addressableModel, upstreams: [provider] });
      }
    }

    return out;
  }));

  for (const result of perUpstream) {
    if (result.status === 'rejected') {
      continue;
    }
    for (const entry of result.value) push(entry);
  }

  // Stable id ordering matches the listed surface so consumers can rely on
  // a single comparator across both halves.
  return entries.sort((a, b) => compareModelIds(a.id, b.id));
};
