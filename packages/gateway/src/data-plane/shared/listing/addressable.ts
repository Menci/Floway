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

import { compareModelIds, getModelsFromProviders } from '../../providers/catalog.ts';
import { readUpstreamModelsSnapshotAndScheduleRefresh } from '../../providers/models-cache.ts';
import { listModelProviders } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { isAbortError, type Fetcher, type InternalModel, type Provider, type UpstreamRecord } from '@floway-dev/provider';

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

// Enumerate every inbound id the data plane accepts under `upstreamFilter`,
// tagged with whether the id participates in the default `/v1/models`
// listing. Fans out persisted snapshot reads the same way
// `collectProviderModels` does; repeated stale access may submit or join the
// same separate background refresh trigger.
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
  const seen = new Set<string>();
  const push = (entry: AddressableIdEntry): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };

  for (const model of realModels) {
    push({ id: model.id, unlisted: undefined, model, upstreams: upstreamsByPublicId.get(model.id) ?? [] });
  }

  // Prefix alternates reuse the same persisted provider snapshots as the
  // listed surface. Repeated access may join the same L1 refresh trigger, but
  // never performs upstream model-list I/O in this request.
  const perUpstream = await Promise.allSettled(providers.map(async provider => {
    const cfg = provider.modelPrefix;
    const addressableOnly = cfg !== null ? cfg.addressable.filter(form => !cfg.listed.includes(form)) : [];
    if (cfg === null || addressableOnly.length === 0) return [] as AddressableIdEntry[];

    const upstreamModels = readUpstreamModelsSnapshotAndScheduleRefresh(provider, { scheduler, fetcher: fetcherForUpstream(provider.upstreamId) }).models;
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
      const canonicalUpstreams = upstreamsByPublicId.get(canonicalPublicId) ?? [];
      for (const form of addressableOnly) {
        const id = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
        out.push({ id, unlisted: true, model: canonical, upstreams: canonicalUpstreams });
      }
    }

    return out;
  }));

  for (const result of perUpstream) {
    if (result.status === 'rejected') {
      // Snapshot setup failures omit only that provider; cancellation still
      // withdraws the whole caller operation.
      if (isAbortError(result.reason)) throw result.reason;
      continue;
    }
    for (const entry of result.value) push(entry);
  }

  // Stable id ordering matches the listed surface so consumers can rely on
  // a single comparator across both halves.
  return entries.sort((a, b) => compareModelIds(a.id, b.id));
};
