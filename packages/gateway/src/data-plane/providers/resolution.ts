import { internalModelFromProviderModel } from './catalog.ts';
import { fetchUpstreamModelsCached } from './models-cache.ts';
import { listModelProviders, type GatewayProvider } from './registry.ts';
import { settleUnlessAborted } from './settle.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord } from '../../repo/types.ts';
import { serializeCanonicalJson } from '../../repo/upstream-json.ts';
import { retainUpstreamFetcher } from '../shared/retained-response.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { type AliasRules, endpointsSupportKind, type ModelKind } from '@floway-dev/protocols/common';
import type { Fetcher, ModelCandidate, ProviderModel } from '@floway-dev/provider';

interface ProviderCatalogAccess {
  readonly fetcher: Fetcher;
  readonly modelsById: ReadonlyMap<string, ProviderModel>;
  readonly disabledModelIds: ReadonlySet<string>;
}

type ProviderCatalogLoader = (provider: GatewayProvider) => Promise<ProviderCatalogAccess>;

// One model-resolution request gets one catalog promise and one fetcher per
// provider. Keeping rejected promises in this request-local memo is deliberate:
// an alias with many targets must not turn one cold catalog outage into one
// upstream request per target.
const createProviderCatalogLoader = (
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): ProviderCatalogLoader => {
  const byProvider = new Map<GatewayProvider, Promise<ProviderCatalogAccess>>();
  return provider => {
    const existing = byProvider.get(provider);
    if (existing !== undefined) return existing;
    const loading = (async () => {
      const fetcher = fetcherForUpstream(provider.upstreamId);
      const models = await fetchUpstreamModelsCached(provider, { scheduler, fetcher });
      const modelsById = new Map<string, ProviderModel>();
      for (const model of models) {
        if (!modelsById.has(model.id)) modelsById.set(model.id, model);
      }
      return { fetcher, modelsById, disabledModelIds: new Set(provider.disabledPublicModelIds) };
    })();
    byProvider.set(provider, loading);
    return loading;
  };
};

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
// The requested endpoint family is threaded down so a model contributes when
// its endpoint map serves that family, even if a different family owns its
// primary catalog `kind`. `sawAnyId` remains family-independent.
const enumerateOneUpstreamCandidates = async (
  provider: GatewayProvider,
  modelId: string,
  kind: ModelKind,
  loadCatalog: ProviderCatalogLoader,
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

  const { fetcher, modelsById, disabledModelIds } = await loadCatalog(provider);
  const candidates: ModelCandidate[] = [];
  let sawAnyId = false;
  for (const lookupId of lookupIds) {
    const match = modelsById.get(lookupId);
    if (match !== undefined && disabledModelIds.has(match.id)) continue;
    if (!match) continue;
    sawAnyId = true;
    if (endpointsSupportKind(match.endpoints, kind)) {
      candidates.push({ provider, model: internalModelFromProviderModel(match, provider.upstreamId), fetcher });
    }
  }
  return { candidates, sawAnyId };
};

// Walk every visible upstream, in configured order, and collect every
// (provider, model, fetcher) candidate the inbound id resolves against
// at the requested kind. Per-upstream catalog fetches fan out concurrently
// so a slow upstream cannot stall the rest. Provider `AbortError` values still
// propagate. Client disconnect prevents a catalog request that has not yet
// dispatched, while a retained request already in flight runs to completion.
//
// `sawAnyId` aggregates the per-upstream signal: true when at least one
// upstream's catalog carried the inbound id under any endpoint family. The
// caller uses it to avoid a dated-suffix retry once the literal id is known.
export const enumerateRealModelCandidates = async (
  modelId: string,
  kind: ModelKind,
  providers: readonly GatewayProvider[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  clientDisconnectSignal?: AbortSignal,
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawAnyId: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const loadCatalog = createProviderCatalogLoader(fetcherForUpstream, scheduler);
  return await enumerateRealModelCandidatesWithLoader(modelId, kind, providers, loadCatalog, clientDisconnectSignal);
};

const enumerateRealModelCandidatesWithLoader = async (
  modelId: string,
  kind: ModelKind,
  providers: readonly GatewayProvider[],
  loadCatalog: ProviderCatalogLoader,
  clientDisconnectSignal?: AbortSignal,
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawAnyId: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  clientDisconnectSignal?.throwIfAborted();
  const settled = await settleUnlessAborted(providers.map(provider => {
    clientDisconnectSignal?.throwIfAborted();
    return enumerateOneUpstreamCandidates(provider, modelId, kind, loadCatalog);
  }));
  clientDisconnectSignal?.throwIfAborted();

  const failedUpstreams: string[] = [];
  const candidates: ModelCandidate[] = [];
  let sawAnyId = false;
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      clientDisconnectSignal?.throwIfAborted();
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
  enumerateReal: (modelId: string, kind: ModelKind) => ReturnType<typeof enumerateRealModelCandidatesWithLoader>,
): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const first = await enumerateReal(modelId, kind);
  if (first.candidates.length > 0 || first.sawAnyId || !DATED_SUFFIX.test(modelId)) {
    return { candidates: first.candidates, sawModel: first.sawAnyId, failedUpstreams: first.failedUpstreams };
  }
  const stripped = modelId.replace(DATED_SUFFIX, '');
  const second = await enumerateReal(stripped, kind);
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

type AliasCandidate = ModelCandidate & { readonly rules: AliasRules };

interface AliasCandidateCollector {
  readonly candidates: ModelCandidate[];
  readonly add: (candidate: AliasCandidate) => void;
}

const createAliasCandidateCollector = (): AliasCandidateCollector => {
  const rulesByUpstreamByModel = new Map<string, Map<string, Set<string>>>();
  const candidates: ModelCandidate[] = [];
  const add = (candidate: AliasCandidate): void => {
    let byUpstream = rulesByUpstreamByModel.get(candidate.model.id);
    if (byUpstream === undefined) {
      byUpstream = new Map();
      rulesByUpstreamByModel.set(candidate.model.id, byUpstream);
    }
    let rules = byUpstream.get(candidate.provider.upstreamId);
    if (rules === undefined) {
      rules = new Set();
      byUpstream.set(candidate.provider.upstreamId, rules);
    }
    const rulesKey = serializeCanonicalJson(candidate.rules);
    if (rules.has(rulesKey)) return;
    rules.add(rulesKey);
    candidates.push(candidate);
  };
  return { candidates, add };
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
// The real-catalog resolver walks every visible upstream, filters by requested
// endpoint-family support inside the walk, and
// retries once with an eight-digit dated suffix stripped when the id
// matched nothing at all. `sawModel` reports whether the id was known to
// any upstream regardless of family, so the caller can distinguish "model
// missing" (404) from "model does not serve this family" (400).
//
// Resolution filters endpoint-family support here. Callers still select the
// exact target protocol or endpoint key from `model.endpoints`.
//
// The alias walk is a natural top-of-chain check: by construction an
// alias's target id is a real model id, so the shadow pattern (an alias
// whose first target matches its own name) resolves to the real model on
// the first pass; alias names never re-enter the alias layer.
export const enumerateModelCandidates = async ({
  upstreamIds, model, kind, scheduler, runtimeLocation, clientDisconnectSignal,
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
  clientDisconnectSignal?: AbortSignal;
}): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  clientDisconnectSignal?.throwIfAborted();
  if (upstreamIds !== null && upstreamIds.length === 0) {
    return { candidates: [], sawModel: false, failedUpstreams: [] };
  }

  const repo = getRepo();
  const upstreams = await repo.upstreams.list();
  clientDisconnectSignal?.throwIfAborted();
  const providers = await listModelProviders(upstreamIds, upstreams);
  if (providers.length === 0) {
    return { candidates: [], sawModel: false, failedUpstreams: [] };
  }
  const createFetcherForUpstream = await createPerRequestFetcher(runtimeLocation, upstreams);
  clientDisconnectSignal?.throwIfAborted();
  const fetcherForUpstream = (upstreamId: string): Fetcher => {
    const fetcher = createFetcherForUpstream(upstreamId);
    return clientDisconnectSignal === undefined
      ? fetcher
      : retainUpstreamFetcher(fetcher, clientDisconnectSignal, scheduler);
  };
  const loadCatalog = createProviderCatalogLoader(fetcherForUpstream, scheduler);
  const enumerateReal = (modelId: string, modelKind: ModelKind) =>
    enumerateRealModelCandidatesWithLoader(modelId, modelKind, providers, loadCatalog, clientDisconnectSignal);

  const alias = await repo.modelAliases.getByName(model);
  clientDisconnectSignal?.throwIfAborted();
  if (alias === null) {
    return await resolveRealCandidates(model, kind, enumerateReal);
  }
  if (alias.kind !== kind) {
    return { candidates: [], sawModel: true, failedUpstreams: [] };
  }

  // Walk every target, tag each returned candidate with the target's rule
  // overlay, then flatten (target order preserved), and dedup by
  // (modelId, upstreamId, rules). Different rules against the same
  // (model, upstream) stay as distinct entries so the operator can pin the
  // same physical binding under two rule variants.
  const aggregatedFailed = new Set<string>();
  let sawAny = false;
  const collected = createAliasCandidateCollector();
  for (const target of orderAliasTargets(alias)) {
    const result = await resolveRealCandidates(target.target_model_id, kind, enumerateReal);
    for (const name of result.failedUpstreams) aggregatedFailed.add(name);
    if (result.sawModel) sawAny = true;
    for (const candidate of result.candidates) {
      collected.add({ ...candidate, rules: target.rules });
    }
  }
  return {
    candidates: collected.candidates,
    sawModel: sawAny,
    failedUpstreams: [...aggregatedFailed],
  };
};
