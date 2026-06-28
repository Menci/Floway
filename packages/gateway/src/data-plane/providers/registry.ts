import { fetchUpstreamModelsCached } from './models-cache.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { type ModelEndpointKey, type ModelEndpoints, type ModelKind, kindForEndpoints } from '@floway-dev/protocols/common';
import { isAbortError, type InternalModel, type Fetcher, type ModelProviderInstance, type ProviderCandidate, type UpstreamModel, type UpstreamProviderKind, type UpstreamRecord } from '@floway-dev/provider';
import { createAzureProvider } from '@floway-dev/provider-azure';
import { createClaudeCodeProvider } from '@floway-dev/provider-claude-code';
import { createCodexProvider } from '@floway-dev/provider-codex';
import { createCopilotProvider } from '@floway-dev/provider-copilot';
import { createCustomProvider } from '@floway-dev/provider-custom';
import { createOllamaProvider } from '@floway-dev/provider-ollama';

interface ProviderModelsResult {
  models: InternalModel[];
  // Reverse index: every upstream instance that emitted an entry under the
  // given public id, in enumeration order. The control-plane catalog
  // endpoint reads this to render `upstreams: [{kind, id, name}]` per row.
  upstreamsByPublicId: Map<string, ModelProviderInstance[]>;
  sawSuccess: boolean;
  lastError: unknown;
  // Upstream names whose catalog fetch rejected this round, in the same
  // order as the input `providers` list so the model-missing renderer can
  // surface a stable, dashboard-aligned list.
  failedUpstreams: string[];
}

const NO_UPSTREAM_CONFIGURED_MESSAGE = 'No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard';

type ProviderFactory = (record: UpstreamRecord) => ModelProviderInstance | Promise<ModelProviderInstance>;

const providerFactories: Record<UpstreamProviderKind, ProviderFactory> = {
  copilot: createCopilotProvider,
  custom: createCustomProvider,
  azure: createAzureProvider,
  codex: createCodexProvider,
  'claude-code': createClaudeCodeProvider,
  ollama: createOllamaProvider,
};

export const createProviderInstance = (record: UpstreamRecord): ModelProviderInstance | Promise<ModelProviderInstance> =>
  providerFactories[record.provider](record);

// The upstream scope is a required argument across the catalog-assembly chain
// (this, getModels) so a caller can never omit it and silently receive the
// full, unscoped catalog — a missing scope is a compile error, not a runtime
// leak. Pass `null` to deliberately request every enabled upstream.
export const listModelProviders = async (
  upstreamFilter: readonly string[] | null,
): Promise<ModelProviderInstance[]> => {
  const upstreams = await getRepo().upstreams.list();
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

  const providers: ModelProviderInstance[] = [];
  for (const upstream of selection) {
    const factory = providerFactories[upstream.provider];
    providers.push(await factory(upstream));
  }

  return providers;
};

// Merge two capability maps: a key present in either side is present in the
// result, and its sub-capability flags are OR-ed so a sub-cap advertised by
// either provider survives.
const unionEndpoints = (a: ModelEndpoints, b: ModelEndpoints): ModelEndpoints => {
  const result: ModelEndpoints = { ...a };
  for (const key of Object.keys(b) as ModelEndpointKey[]) {
    const merged = { ...result[key], ...b[key] };
    (result as Record<ModelEndpointKey, object>)[key] = merged;
  }
  return result;
};

const catalogFromUpstreamModel = (upstreamModel: UpstreamModel): InternalModel => {
  const { providerData: _providerData, enabledFlags: _enabledFlags, endpoints, ...internal } = upstreamModel;
  return { ...internal, endpoints: { ...endpoints } };
};

// When multiple upstreams expose the same public model id, the first wins
// for `/models` metadata and later ones union-merge their endpoint capability
// map — the merged `endpoints` is the gateway-wide reach for that public id.
// `kind` is recomputed from the union so a chat-only id that later acquires
// an embedding-capable upstream gets correctly reclassified. The reverse
// index `upstreamsByPublicId` accumulates every upstream that surfaced the
// id, in enumeration order, so the control plane can render its per-model
// upstream chips without re-walking the catalog.
const mergeIntoCatalog = (
  byId: Map<string, InternalModel>,
  upstreamsByPublicId: Map<string, ModelProviderInstance[]>,
  instance: ModelProviderInstance,
  surfacedModel: UpstreamModel,
  publicId: string,
): void => {
  const existing = byId.get(publicId);
  if (!existing) {
    byId.set(publicId, catalogFromUpstreamModel(surfacedModel));
    upstreamsByPublicId.set(publicId, [instance]);
    return;
  }
  const endpoints = unionEndpoints(existing.endpoints, surfacedModel.endpoints);
  byId.set(publicId, {
    ...existing,
    endpoints,
    kind: kindForEndpoints(endpoints),
  });
  // We're on the merge branch (`existing !== undefined`), so the parallel
  // `upstreamsByPublicId` entry was populated by the earlier insertion branch
  // and must exist.
  const instances = upstreamsByPublicId.get(publicId);
  if (instances === undefined) throw new Error(`invariant broken: upstreamsByPublicId missing ${publicId}`);
  instances.push(instance);
};

const collectProviderModels = async (
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ProviderModelsResult> => {
  const byId = new Map<string, InternalModel>();
  const upstreamsByPublicId = new Map<string, ModelProviderInstance[]>();
  let sawSuccess = false;
  let lastError: unknown = null;
  const failedUpstreams: string[] = [];

  // Fan out per-upstream so a slow provider does not stall the rest. The SWR
  // cache layer dedupes concurrent in-flight fetches per upstream and serves
  // the SOFT-fresh row without an upstream round trip, so the parallel walk
  // is cheap on the warm path and bounded by `max(per-upstream fetch)` on
  // the cold path.
  const fetchOne = (instance: ModelProviderInstance) =>
    fetchUpstreamModelsCached(instance, {
      scheduler,
      fetcher: fetcherForUpstream(instance.upstream),
    }).then(models => ({ instance, models }));

  const settled = await Promise.allSettled(providers.map(fetchOne));

  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      // Caller-driven cancellation must propagate. Burying it in lastError
      // and letting an earlier sawSuccess return a partially-populated
      // model list would mask the abort and let the rest of the data-plane
      // request build a Response against a stale catalog. `isAbortError`
      // walks the cause chain so an AbortError wrapped inside
      // ProviderModelsUnavailableError still surfaces here.
      const error = result.reason;
      if (isAbortError(error)) throw error;
      lastError = error;
      failedUpstreams.push(providers[index].name);
      continue;
    }
    sawSuccess = true;
    const { instance, models: providedModels } = result.value;
    // Operator-disabled public model ids vanish entirely for this upstream:
    // dropped before they reach the catalog map, so they appear in no /models
    // listing and resolve to nothing for routing. The disable is per-upstream,
    // so the same id can still surface from another upstream that allows it.
    // The disable matches against the bare upstream id, so a disabled `gpt-4o`
    // hides both `gpt-4o` and `<prefix>gpt-4o` from this upstream's
    // contribution.
    const disabled = new Set(instance.disabledPublicModelIds);
    for (const upstreamModel of providedModels) {
      if (!upstreamModel.id) continue;
      if (disabled.has(upstreamModel.id)) continue;

      // Each surface form the upstream chose to list becomes its own catalog
      // entry. The unprefixed surface keeps the original UpstreamModel; the
      // prefixed surface uses a shallow clone with the rewritten id and a
      // synthesized display_name that prepends the upstream name (so the
      // dashboard tells the operator at a glance which upstream a prefixed
      // model came from). `providerData` (where the per-provider call reads
      // the real upstream model id) is untouched by the clone.
      const cfg = instance.modelPrefix;
      if (cfg !== null) {
        for (const form of cfg.listed) {
          const publicId = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
          const surfacedModel: UpstreamModel = form === 'prefixed'
            ? { ...upstreamModel, id: publicId, display_name: `${instance.name}: ${upstreamModel.display_name ?? upstreamModel.id}` }
            : upstreamModel;
          mergeIntoCatalog(byId, upstreamsByPublicId, instance, surfacedModel, publicId);
        }
      } else {
        mergeIntoCatalog(byId, upstreamsByPublicId, instance, upstreamModel, upstreamModel.id);
      }
    }
  }

  return { models: [...byId.values()], upstreamsByPublicId, sawSuccess, lastError, failedUpstreams };
};

// Public-facing model-id ordering, applied in getModels() to every list that
// crosses a gateway boundary (data-plane /v1/models, /models, /v1beta/models
// and the control-plane /api/models that backs the dashboard models page).
// Provider upstreams return models in arbitrary order; sorting here gives the
// dashboard and downstream clients a stable, family-grouped view.
//
// Sort keys, evaluated in order:
//   0. Whether the id contains a '/'. Slashed ids (Microsoft Foundry router
//      model ids like "accounts/msft/routers/x") are pushed to the tail so
//      the typical flat ids stay on top.
//   1. Leading [a-zA-Z]+ prefix, case-insensitive, ascending. Groups model
//      families: "claude-haiku-4-5" -> "claude", "deepseek-v4-pro" ->
//      "deepseek".
//   2. Array of isolated single digits (a digit surrounded on both sides by a
//      non-digit, with start/end of string counting as non-digit), compared
//      element by element as integers, DESCENDING — newer/larger versions
//      first: "claude-opus-4-7" -> [4, 7] beats "claude-opus-4-5" -> [4, 5];
//      "gpt-5.5" -> [5, 5] beats "gpt-4o" -> [4]. Multi-digit runs (dates,
//      "20300101") are intentionally not counted as version parts.
//   3. Full string lex order, DESCENDING, case-folded first then raw — keeps
//      "GPT-4o" and "gpt-4o" adjacent while giving longer/later suffixes
//      priority within an otherwise tied group.
export const compareModelIds = (a: string, b: string): number => {
  const cmp = <T>(x: T, y: T, dir = 1) => (x < y ? -dir : x > y ? dir : 0);
  const prefix = (s: string) => /^[a-zA-Z]+/.exec(s)?.[0].toLowerCase() ?? '';
  const digits = (s: string) => [...s.matchAll(/(?<!\d)\d(?!\d)/g)].map(m => +m[0]);
  const [da, db] = [digits(a), digits(b)];
  return cmp(+a.includes('/'), +b.includes('/'))
    || cmp(prefix(a), prefix(b))
    || (da.slice(0, Math.min(da.length, db.length)).map((v, i) => db[i] - v).find(d => d !== 0) ?? db.length - da.length)
    || cmp(a.toLowerCase(), b.toLowerCase(), -1)
    || cmp(a, b, -1);
};

// `fetcherForUpstream` routes each upstream's catalog fetch through its
// per-upstream proxy chain. Returns the merged catalog together with the
// reverse `upstreamsByPublicId` map and the list of upstream names whose
// catalog fetch rejected during this assembly; callers that only want the
// bare metadata projection (`/v1/models`, `/models`, etc.) destructure
// `models` and ignore the rest.
export const getModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{ models: InternalModel[]; upstreamsByPublicId: Map<string, ModelProviderInstance[]>; failedUpstreams: readonly string[] }> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error(NO_UPSTREAM_CONFIGURED_MESSAGE);
  }

  const { models, upstreamsByPublicId, sawSuccess, lastError, failedUpstreams } = await collectProviderModels(providers, fetcherForUpstream, scheduler);

  // TODO: surface `failedUpstreams` on each listing endpoint's wire response
  // so partial-listing failures reach clients.
  if (sawSuccess) return { models: models.sort((a, b) => compareModelIds(a.id, b.id)), upstreamsByPublicId, failedUpstreams };
  if (lastError) throw lastError;
  // `Promise.allSettled` with a non-empty `providers` always yields at least
  // one settled entry — the prior `lastError` branch covers the all-rejected
  // case, the `sawSuccess` branch covers any-resolved. There is no third
  // state where every provider settled but neither flag flipped.
  throw new Error('invariant broken: collectProviderModels resolved with neither success nor failure');
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
// `kind` is threaded down here so a wrong-kind catalog entry never becomes
// a candidate. `sawAnyId` is true whenever the lookup id appeared in the
// catalog regardless of kind, so the caller can distinguish
// "id is unknown to this upstream" from "id exists but wrong kind".
const enumerateOneUpstreamCandidates = async (
  provider: ModelProviderInstance,
  modelId: string,
  kind: ModelKind,
  fetcher: Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{ candidates: ProviderCandidate[]; sawAnyId: boolean }> => {
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
  const candidates: ProviderCandidate[] = [];
  let sawAnyId = false;
  for (const lookupId of lookupIds) {
    const match = providedModels.find(m => m.id === lookupId && !disabled.has(m.id));
    if (!match) continue;
    sawAnyId = true;
    if (match.kind === kind) candidates.push({ provider, model: match, fetcher });
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
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{
  readonly candidates: readonly ProviderCandidate[];
  readonly sawAnyId: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const settled = await Promise.allSettled(providers.map(provider =>
    enumerateOneUpstreamCandidates(provider, modelId, kind, fetcherForUpstream(provider.upstream), scheduler)));

  const failedUpstreams: string[] = [];
  const candidates: ProviderCandidate[] = [];
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

// Per-request model resolution, structured as the user-spec call chain:
//
//   1. Resolve the inbound id against every visible upstream at the
//      requested kind (real-model walk — `enumerateRealModelCandidates`).
//      Wrong-kind catalog entries are dropped inside that walk, so they
//      never reach this layer as candidates.
//   2. If the id matched no upstream catalog at all (`sawAnyId=false`)
//      and the id ends in `-YYYYMMDD`, strip the suffix and walk again.
//      The retry runs the full provider list, so the stripped id is
//      exposed in the same enumeration order as the original attempt.
//      A wrong-kind match does NOT trigger retry — the suffix strip
//      cannot turn a wrong-kind model into a right-kind one.
//
// `sawModel` is true whenever the inbound id (or its dated-stripped form)
// appeared in some upstream catalog regardless of kind. Callers use it to
// distinguish "model id is unknown to every configured upstream"
// (sawModel=false) from "model exists but is the wrong kind for this
// endpoint" (sawModel=true, candidates=[]).
//
// Endpoint-level narrowing — picking the chat target protocol from
// `model.endpoints`, or checking the specific `imagesEdits` /
// `imagesGenerations` / `completions` endpoint key — is the caller's job.
// This function stays endpoint-blind so the same path serves chat,
// embeddings, image generation/edits, and legacy completions.
export const enumerateModelCandidates = async ({
  upstreamIds, model, kind, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  kind: ModelKind;
  // Threaded into `enumerateRealModelCandidates` so the per-upstream
  // catalog lookup hits the SWR-cached `fetchUpstreamModelsCached` instead
  // of round-tripping to the upstream on every request.
  scheduler: BackgroundScheduler;
  // Current colo for this request — see GatewayCtx.currentColo. Threaded
  // into the per-request fetcher so colo-scoped fallback entries can be
  // honoured at dial time.
  currentColo: string;
}): Promise<{
  readonly candidates: readonly ProviderCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);

  const first = await enumerateRealModelCandidates(model, kind, providers, fetcherForUpstream, scheduler);
  if (first.candidates.length > 0 || first.sawAnyId || !DATED_SUFFIX.test(model)) {
    return { candidates: first.candidates, sawModel: first.sawAnyId, failedUpstreams: first.failedUpstreams };
  }
  const stripped = model.replace(DATED_SUFFIX, '');
  const second = await enumerateRealModelCandidates(stripped, kind, providers, fetcherForUpstream, scheduler);
  return {
    candidates: second.candidates,
    sawModel: second.sawAnyId,
    failedUpstreams: [...new Set([...first.failedUpstreams, ...second.failedUpstreams])],
  };
};
