import { unionEndpoints } from './endpoint-union.ts';
import { fetchUpstreamModelsCached, MODEL_CATALOG_REVISION } from './models-cache.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { kindForEndpoints } from '@floway-dev/protocols/common';
import { isAbortError, type Fetcher, type InternalModel, type Provider, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

interface ProviderModelsResult {
  models: InternalModel[];
  // Reverse index: every upstream instance that emitted an entry under the
  // given public id, in enumeration order. The control-plane catalog
  // endpoint reads this to render `upstreams: [{kind, id, name}]` per row;
  // the alias listing reads it to project per-target upstream chips.
  upstreamsByPublicId: Map<string, Provider[]>;
  sawSuccess: boolean;
  lastError: unknown;
  // Upstream names whose catalog fetch rejected this round, in the same
  // order as the input `providers` list so the model-missing renderer can
  // surface a stable, dashboard-aligned list.
  failedUpstreams: string[];
}

// Lift a provider-emitted `ProviderModel` into an `InternalModel`, seeding
// `providerModels` with the sole entry keyed on the emitting upstream id.
// The provider model is stored verbatim under that entry so dispatch hands
// the same reference back to the provider's `callXxx`.
export const internalModelFromProviderModel = (providerModel: ProviderModel, upstreamId: string): InternalModel => {
  const { providerData, enabledFlags, flagOverrides, rerankTarget, endpoints, ...metadata } = providerModel;
  return {
    ...metadata,
    endpoints: { ...endpoints },
    providerModels: { [upstreamId]: providerModel },
  };
};

// When multiple upstreams expose the same public model id, the first wins
// for `/models` metadata and later ones union-merge their endpoint capability
// map — the merged `endpoints` is the gateway-wide reach for that public id.
// `kind` is recomputed from the union so a chat-only id that later acquires
// an embedding-capable upstream gets correctly reclassified. Each contribution
// adds its own entry to `providerModels` keyed on the contributing upstream id
// with the emitted `ProviderModel` stored verbatim, so the same public id
// carrying data from N upstreams ends up with N entries. The reverse index
// `upstreamsByPublicId` accumulates every upstream that surfaced the id, in
// enumeration order, so the control plane can render its per-model upstream
// chips without re-walking the catalog.
const mergeIntoCatalog = (
  byId: Map<string, InternalModel>,
  upstreamsByPublicId: Map<string, Provider[]>,
  instance: Provider,
  surfacedModel: ProviderModel,
  publicId: string,
): void => {
  const existing = byId.get(publicId);
  if (!existing) {
    byId.set(publicId, internalModelFromProviderModel(surfacedModel, instance.upstreamId));
    upstreamsByPublicId.set(publicId, [instance]);
    return;
  }
  // The catalog only stores real (upstream-backed) rows; alias-synthesized
  // rows join the caller-facing catalog downstream via `mergeAliasesIntoModels`.
  // Narrow off the discriminated union so the merge below sees a concrete
  // `providerModels` map.
  if (existing.providerModels === undefined) {
    throw new Error(`mergeIntoCatalog: catalog row for '${publicId}' unexpectedly carries aliasedFrom instead of providerModels`);
  }
  const endpoints = unionEndpoints([existing.endpoints, surfacedModel.endpoints]);
  byId.set(publicId, {
    ...existing,
    endpoints,
    kind: kindForEndpoints(endpoints),
    providerModels: {
      ...existing.providerModels,
      [instance.upstreamId]: surfacedModel,
    },
  });
  // We're on the merge branch (`existing !== undefined`), so the parallel
  // `upstreamsByPublicId` entry was populated by the earlier insertion branch
  // and must exist.
  const instances = upstreamsByPublicId.get(publicId);
  if (instances === undefined) throw new Error(`invariant broken: upstreamsByPublicId missing ${publicId}`);
  instances.push(instance);
};

const collectProviderModels = async (
  providers: readonly Provider[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ProviderModelsResult> => {
  const byId = new Map<string, InternalModel>();
  const upstreamsByPublicId = new Map<string, Provider[]>();
  let sawSuccess = false;
  let lastError: unknown = null;
  const failedUpstreams: string[] = [];

  // Fan out per-upstream so a slow provider does not stall the rest. The SWR
  // cache layer dedupes concurrent in-flight fetches per upstream and serves
  // the SOFT-fresh row without an upstream round trip, so the parallel walk
  // is cheap on the warm path and bounded by `max(per-upstream fetch)` on
  // the cold path.
  const fetchOne = (instance: Provider) =>
    fetchUpstreamModelsCached(instance, {
      scheduler,
      fetcher: fetcherForUpstream(instance.upstreamId),
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
    // The disable matches the pre-prefix public id — the id the provider's
    // own catalog projection publishes, before this loop surfaces it in each
    // listed form — so a disabled `gpt-4o` hides both `gpt-4o` and
    // `<prefix>gpt-4o` from this upstream's contribution.
    const disabled = new Set(instance.disabledPublicModelIds);
    for (const providerModel of providedModels) {
      if (!providerModel.id) continue;
      if (disabled.has(providerModel.id)) continue;

      // Each surface form the upstream chose to list becomes its own catalog
      // entry. The unprefixed surface keeps the original ProviderModel; the
      // prefixed surface uses a shallow clone with the rewritten id and a
      // synthesized display_name that prepends the upstream name (so the
      // dashboard tells the operator at a glance which upstream a prefixed
      // model came from). `providerData` (where the per-provider call reads
      // the real upstream model id) is untouched by the clone.
      const cfg = instance.modelPrefix;
      if (cfg !== null) {
        for (const form of cfg.listed) {
          const publicId = form === 'prefixed' ? `${cfg.prefix}${providerModel.id}` : providerModel.id;
          const surfacedModel: ProviderModel = form === 'prefixed'
            ? { ...providerModel, id: publicId, display_name: `${instance.name}: ${providerModel.display_name ?? providerModel.id}` }
            : providerModel;
          mergeIntoCatalog(byId, upstreamsByPublicId, instance, surfacedModel, publicId);
        }
      } else {
        mergeIntoCatalog(byId, upstreamsByPublicId, instance, providerModel, providerModel.id);
      }
    }
  }

  return { models: [...byId.values()], upstreamsByPublicId, sawSuccess, lastError, failedUpstreams };
};

// How many catalog entries this upstream's stored catalog would surface, under
// the surfacing rules the loop above applies: an operator-disabled id
// contributes nothing, and a prefix policy contributes one entry per listed
// form. Null when the row holds no catalog written under the current revision.
//
// The registry builds providers from enabled upstreams only, so a disabled
// upstream contributes nothing to the live catalog and the dashboard cannot
// count it from there. This is the count it had while it was on, which is the
// last one that was ever true for it.
export const storedCatalogSize = (record: UpstreamRecord): number | null => {
  const cache = record.modelsCache;
  if (cache?.revision !== MODEL_CATALOG_REVISION) return null;
  const disabled = new Set(record.disabledPublicModelIds);
  const surfacedForms = record.modelPrefix?.listed.length ?? 1;
  return cache.models.filter(model => model.id && !disabled.has(model.id)).length * surfacedForms;
};

// Public-facing model-id ordering, applied to the real-model slice of the
// lists that cross a gateway boundary (data-plane /v1/models, /models,
// /v1beta/models and the control-plane /api/models that backs the dashboard
// models page). It orders that slice only: visible aliases are appended
// afterwards in alias `sortOrder`, and `/api/models?include_unlisted=true`
// appends the unlisted rows after the listed ones.
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

// Catalog assembly against an already-resolved provider list. Callers that
// already paid the `listModelProviders` round-trip — the alias prelude
// shares its provider list across the alias resolver and the candidate
// walk — pass providers through to avoid the duplicate upstreams.list()
// DB query.
export const getModelsFromProviders = async (
  providers: readonly Provider[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{ models: InternalModel[]; upstreamsByPublicId: Map<string, Provider[]>; failedUpstreams: readonly string[] }> => {
  if (providers.length === 0) {
    throw new Error('No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard');
  }

  const { models, upstreamsByPublicId, sawSuccess, lastError, failedUpstreams } = await collectProviderModels(providers, fetcherForUpstream, scheduler);

  // TODO: surface `failedUpstreams` on each listing endpoint's wire response
  // so partial-listing failures reach clients.
  if (sawSuccess) return { models: models.sort((a, b) => compareModelIds(a.id, b.id)), upstreamsByPublicId, failedUpstreams };
  if (lastError) throw lastError;
  return { models: [], upstreamsByPublicId, failedUpstreams };
};
