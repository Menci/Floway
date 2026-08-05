import { isEqual, uniqWith } from 'es-toolkit';

import { internalModelFromProviderModel } from './catalog.ts';
import { fetchUpstreamModelsCached } from './models-cache.ts';
import { listModelProviders } from './registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord } from '../../repo/types.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';
import { isAbortError, type Fetcher, type ModelCandidate, type Provider } from '@floway-dev/provider';

// Resolve one inbound id against one upstream. The upstream's
// `modelPrefix.addressable` configuration decides which lookup branches
// apply: an `unprefixed`-addressable upstream is probed with the inbound id
// verbatim; a `prefixed`-addressable upstream is probed with the inbound id
// minus its configured prefix when (and only when) the inbound carries that
// prefix. Both branches are evaluated against the same SWR-cached catalog
// fetch — a single upstream typically contributes at most one candidate,
// but a catalog that publishes both the bare and prefixed forms can match
// twice and both go through.
//
// `kind` is threaded down here so a wrong-kind catalog entry never becomes
// a candidate. `sawAnyId` is true whenever the lookup id appeared in the
// catalog regardless of kind, so the caller can distinguish
// "id is unknown to this upstream" from "id exists but wrong kind".
const enumerateOneUpstreamCandidates = async (
  provider: Provider,
  modelId: string,
  kind: ModelKind,
  fetcher: Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{ candidates: ModelCandidate[]; sawAnyId: boolean }> => {
  const cfg = provider.modelPrefix;
  const lookupIds: string[] = [];
  if (cfg === null) {
    lookupIds.push(modelId);
  } else {
    for (const form of cfg.addressable) {
      if (form === 'unprefixed') lookupIds.push(modelId);
      else if (form === 'prefixed' && modelId.startsWith(cfg.prefix)) lookupIds.push(modelId.slice(cfg.prefix.length));
    }
  }
  if (lookupIds.length === 0) return { candidates: [], sawAnyId: false };

  const providedModels = await fetchUpstreamModelsCached(provider, { scheduler, fetcher });
  const disabled = new Set(provider.disabledPublicModelIds);
  const candidates: ModelCandidate[] = [];
  let sawAnyId = false;
  for (const lookupId of lookupIds) {
    const match = providedModels.find(m => m.id === lookupId && !disabled.has(m.id));
    if (!match) continue;
    sawAnyId = true;
    if (match.kind === kind) {
      candidates.push({ provider, model: internalModelFromProviderModel(match, provider.upstreamId), fetcher });
    }
  }
  return { candidates, sawAnyId };
};

// Walk every visible upstream, in configured order, and collect every
// (provider, model, fetcher) candidate the inbound id resolves against
// at the requested kind. Per-upstream catalog fetches fan out concurrently
// so a slow upstream cannot stall the rest. Cancellation (`AbortError`)
// propagates so the per-request abort signal cannot be masked by a slow
// upstream's rejection.
//
// `sawAnyId` aggregates the per-upstream signal: true when at least one
// upstream's catalog carried the inbound id under any kind. The caller
// uses it to decide whether to retry with a stripped dated suffix (no
// point retrying if the id matched but only under the wrong kind — the
// suffix strip cannot change kind).
export const enumerateRealModelCandidates = async (
  modelId: string,
  kind: ModelKind,
  providers: readonly Provider[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawAnyId: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const settled = await Promise.allSettled(providers.map(provider =>
    enumerateOneUpstreamCandidates(provider, modelId, kind, fetcherForUpstream(provider.upstreamId), scheduler)));

  const failedUpstreams: string[] = [];
  const candidates: ModelCandidate[] = [];
  let sawAnyId = false;
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      const error = result.reason;
      if (isAbortError(error)) throw error;
      failedUpstreams.push(providers[index].name);
      continue;
    }
    candidates.push(...result.value.candidates);
    sawAnyId = sawAnyId || result.value.sawAnyId;
  }
  return { candidates, sawAnyId, failedUpstreams };
};

// Vendor clients sometimes pin a model id to its release date
// (`claude-sonnet-4-5-20250929`) even though the gateway's merged catalog
// only carries the undated alias. When the inbound id matches no catalog
// entry, strip an 8-digit `-YYYYMMDD` suffix and try once more — failed
// catalog fetches across the two attempts dedupe into a single
// `failedUpstreams` list for the caller's renderer.
const DATED_SUFFIX = /-\d{8}$/;

// Real-catalog resolution with the dated-suffix retry baked in. Used both
// directly (when we already hold the provider list) and by
// `enumerateModelCandidates` below, which lists providers and then delegates
// here — once for each alias target when the inbound id names an alias.
const resolveRealCandidates = async (
  modelId: string,
  kind: ModelKind,
  providers: readonly Provider[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const first = await enumerateRealModelCandidates(modelId, kind, providers, fetcherForUpstream, scheduler);
  if (first.candidates.length > 0 || first.sawAnyId || !DATED_SUFFIX.test(modelId)) {
    return { candidates: first.candidates, sawModel: first.sawAnyId, failedUpstreams: first.failedUpstreams };
  }
  const stripped = modelId.replace(DATED_SUFFIX, '');
  const second = await enumerateRealModelCandidates(stripped, kind, providers, fetcherForUpstream, scheduler);
  return {
    candidates: second.candidates,
    sawModel: second.sawAnyId,
    failedUpstreams: [...new Set([...first.failedUpstreams, ...second.failedUpstreams])],
  };
};

// Target order for an alias walk: `first-available` yields declaration
// order; `random` shuffles so the outer walk distributes uniformly across
// targets. Within a single target's real-catalog walk the per-upstream
// order is always preserved (registry enumeration order); shuffling
// applies to the target list, not to a target's candidates.
const orderAliasTargets = (alias: ModelAliasRecord): readonly ModelAliasRecord['targets'][number][] => {
  if (alias.selection === 'first-available') return alias.targets;
  const shuffled = [...alias.targets];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

// Per-request model resolution. Two-branch chain:
//
//   1. Look the inbound id up in the alias repo. When the id names an
//      alias, walk every target in `selection`-mode order, delegate to the
//      real-catalog resolver for each one, tag each returned candidate
//      with that target's rule overlay, flatten across targets, and dedup
//      by (modelId, upstreamId, rules) — same (model, upstream) with
//      differing rules stays as distinct candidates so both variants can
//      be dispatched. `iterateCandidates` at the serve layer then cascades
//      across every kept candidate: a target's upstreams all failing over
//      falls through into the next target's candidates instead of hard-
//      failing at the first target.
//   2. Otherwise (no alias match at all) run the real-catalog resolver
//      directly on the inbound id.
//
// The real-catalog resolver walks every visible upstream, filters by kind
// inside the walk (so wrong-kind entries never become candidates), and
// retries once with an eight-digit dated suffix stripped when the id
// matched nothing at all. `sawModel` reports whether the id was known to
// any upstream regardless of kind, so the caller can distinguish "model
// missing" (404) from "model wrong kind" (400).
//
// Endpoint-level narrowing — picking the chat target protocol from
// `model.endpoints`, or checking the specific `imagesEdits` /
// `imagesGenerations` / `audioTranscriptions` / `completions` endpoint key —
// is the caller's job.
// This function stays endpoint-blind so the same path serves chat,
// embeddings, image generation/edits, rerank, audio transcription, and
// completions.
//
// The alias walk is a natural top-of-chain check: by construction an
// alias's target id is a real model id, so the shadow pattern (an alias
// whose first target matches its own name) resolves to the real model on
// the first pass; alias names never re-enter the alias layer.
export const enumerateModelCandidates = async ({
  upstreamIds, model, kind, scheduler, runtimeLocation,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  kind: ModelKind;
  // Threaded into `enumerateRealModelCandidates` so the per-upstream
  // catalog lookup hits the SWR-cached `fetchUpstreamModelsCached` instead
  // of round-tripping to the upstream on every request.
  scheduler: BackgroundScheduler;
  // Runtime location tag for this request — see GatewayCtx.runtimeLocation.
  // Threaded into the per-request fetcher so colo-scoped fallback entries
  // can be honoured at dial time.
  runtimeLocation: string;
}): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const fetcherForUpstream = await createPerRequestFetcher(runtimeLocation);
  const providers = await listModelProviders(upstreamIds);

  const alias = await getRepo().modelAliases.getByName(model);
  if (alias === null) {
    return await resolveRealCandidates(model, kind, providers, fetcherForUpstream, scheduler);
  }

  // Walk every target, tag each returned candidate with the target's rule
  // overlay, then flatten (target order preserved), and dedup by
  // (modelId, upstreamId, rules). Different rules against the same
  // (model, upstream) stay as distinct entries so the operator can pin the
  // same physical binding under two rule variants.
  const aggregatedFailed = new Set<string>();
  let sawAny = false;
  const flat: ModelCandidate[] = [];
  for (const target of orderAliasTargets(alias)) {
    const result = await resolveRealCandidates(target.target_model_id, kind, providers, fetcherForUpstream, scheduler);
    for (const name of result.failedUpstreams) aggregatedFailed.add(name);
    if (result.sawModel) sawAny = true;
    for (const candidate of result.candidates) {
      flat.push({ ...candidate, rules: target.rules });
    }
  }
  const deduped = uniqWith(flat, (candidate, existing) =>
    candidate.model.id === existing.model.id
    && candidate.provider.upstreamId === existing.provider.upstreamId
    && isEqual(candidate.rules, existing.rules));
  return {
    candidates: deduped,
    sawModel: sawAny,
    failedUpstreams: [...aggregatedFailed],
  };
};
