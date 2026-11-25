import { unionEndpoints } from './endpoint-union.ts';
import { modelCatalogSource, readUpstreamModelsSnapshotAndScheduleRefresh, MODEL_CATALOG_REVISION } from './models-cache.ts';
import type { ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import type { StoredUpstreamRecord } from '../../repo/types.ts';
import { kindForEndpoints, type OpaqueBlobCompatibilityScope } from '@floway-dev/protocols/common';
import type { InternalModel, ProviderModel, UpstreamChatModelConfig, UpstreamRecord } from '@floway-dev/provider';

interface ProviderModelsResult {
  models: InternalModel[];
  // Reverse index: every upstream that emitted an entry under the
  // given public id, in enumeration order. The control-plane catalog
  // endpoint reads this to render `upstreams: [{kind, id, name}]` per row;
  // the alias listing reads it to project per-target upstream chips.
  upstreamsByPublicId: Map<string, StoredUpstreamRecord[]>;
  // Upstreams carrying a persisted catalog-refresh error, in selection order.
  failedUpstreams: string[];
}

const mergedOpaqueBlobCompatibilityScope = (
  models: readonly ProviderModel[],
): OpaqueBlobCompatibilityScope => {
  const [first, ...rest] = models;
  if (first !== undefined && rest.every(model =>
    model.opaqueBlobCompatibilityScope.bindToUpstream === first.opaqueBlobCompatibilityScope.bindToUpstream
    && model.opaqueBlobCompatibilityScope.key === first.opaqueBlobCompatibilityScope.key)) {
    return first.opaqueBlobCompatibilityScope;
  }
  return { bindToUpstream: true };
};

// A public id may route to any chat provider behind it, so this safety
// capability is the conjunction of their explicit answers. Other chat metadata
// retains the catalog's established first-provider-wins behavior.
const mergedChatMetadata = (
  first: UpstreamChatModelConfig | undefined,
  providerModels: Readonly<Record<string, ProviderModel>>,
): UpstreamChatModelConfig | undefined => {
  const chatModels = Object.values(providerModels).filter(model => model.kind === 'chat');
  if (chatModels.length === 0) return first;
  return {
    ...(first ?? {}),
    image_detail_original: chatModels.every(model => model.chat?.image_detail_original === true),
  };
};

// Lift a provider-emitted `ProviderModel` into an `InternalModel`, seeding
// `providerModels` with the sole entry keyed on the emitting upstream id.
const internalModelFromProviderModel = (providerModel: ProviderModel, upstreamId: string): InternalModel => {
  const { providerData, upstreamModelId: _upstreamModelId, enabledFlags, flagOverrides, rerankTarget: _rerankTarget, decisionTarget: _decisionTarget, endpoints, ...metadata } = providerModel;
  const providerModels = { [upstreamId]: providerModel };
  const chat = mergedChatMetadata(providerModel.chat, providerModels);
  return {
    ...metadata,
    ...(chat === undefined ? {} : { chat }),
    endpoints: { ...endpoints },
    providerModels,
  };
};

// When multiple upstreams expose the same surfaced model id, the first wins
// for metadata and later ones union-merge their endpoint capability map — the
// merged `endpoints` is the gateway-wide reach for that id.
// `chat.image_detail_original` is the safety exception: it is true only when
// every chat provider behind the id explicitly accepts it.
// `kind` is recomputed from the union so a chat-only id that later acquires
// an embedding-capable upstream gets correctly reclassified. Each contribution
// adds its own entry to `providerModels` keyed on the contributing upstream id
// with the emitted `ProviderModel` stored verbatim, so the same id
// carrying data from N upstreams ends up with N entries. The reverse index
// `upstreamsByPublicId` accumulates every upstream that surfaced the id, in
// enumeration order, so the control plane can render its per-model upstream
// chips without re-walking the catalog.
export const mergeIntoCatalog = (
  byId: Map<string, InternalModel>,
  upstreamsByPublicId: Map<string, StoredUpstreamRecord[]>,
  upstream: StoredUpstreamRecord,
  surfacedModel: ProviderModel,
  publicId: string,
): void => {
  const existing = byId.get(publicId);
  if (!existing) {
    byId.set(publicId, internalModelFromProviderModel(surfacedModel, upstream.id));
    upstreamsByPublicId.set(publicId, [upstream]);
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
  const providerModels = {
    ...existing.providerModels,
    [upstream.id]: surfacedModel,
  };
  const chat = mergedChatMetadata(existing.chat, providerModels);
  byId.set(publicId, {
    ...existing,
    ...(chat === undefined ? {} : { chat }),
    opaqueBlobCompatibilityScope: mergedOpaqueBlobCompatibilityScope(Object.values(providerModels)),
    endpoints,
    kind: kindForEndpoints(endpoints),
    providerModels,
  });
  const contributors = upstreamsByPublicId.get(publicId);
  if (contributors === undefined) throw new Error(`invariant broken: upstreamsByPublicId missing ${publicId}`);
  contributors.push(upstream);
};

export const getModelsFromUpstreams = (
  upstreams: readonly StoredUpstreamRecord[],
  scheduleRefresh: ModelsRefreshScheduler,
): ProviderModelsResult => {
  const byId = new Map<string, InternalModel>();
  const upstreamsByPublicId = new Map<string, StoredUpstreamRecord[]>();
  const failedUpstreams: string[] = [];

  for (const upstream of upstreams) {
    const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(modelCatalogSource(upstream), scheduleRefresh);
    const { models: providedModels, lastError: cachedError } = snapshot;
    if (cachedError) {
      failedUpstreams.push(upstream.name);
    }
    // Operator-disabled public model ids vanish entirely for this upstream:
    // dropped before they reach the catalog map, so they appear in no /models
    // listing and resolve to nothing for routing. The disable is per-upstream,
    // so the same id can still surface from another upstream that allows it.
    // The disable matches the pre-prefix public id — the id the provider's
    // own catalog projection publishes, before this loop surfaces it in each
    // listed form — so a disabled `gpt-4o` hides both `gpt-4o` and
    // `<prefix>gpt-4o` from this upstream's contribution.
    const disabled = new Set(upstream.disabledPublicModelIds);
    for (const providerModel of providedModels) {
      if (!providerModel.id) continue;
      if (disabled.has(providerModel.id)) continue;

      // Each surface form the upstream chose to list becomes its own catalog
      // entry. The unprefixed surface keeps the original ProviderModel; the
      // prefixed surface uses a shallow clone with the rewritten id and a
      // synthesized display_name that prepends the upstream name (so the
      // dashboard tells the operator at a glance which upstream a prefixed
      // model came from). The clone retains the upstream model ID.
      const cfg = upstream.modelPrefix;
      if (cfg !== null) {
        for (const form of cfg.listed) {
          const publicId = form === 'prefixed' ? `${cfg.prefix}${providerModel.id}` : providerModel.id;
          const surfacedModel: ProviderModel = form === 'prefixed'
            ? { ...providerModel, id: publicId, display_name: `${upstream.name}: ${providerModel.display_name ?? providerModel.id}` }
            : providerModel;
          mergeIntoCatalog(byId, upstreamsByPublicId, upstream, surfacedModel, publicId);
        }
      } else {
        mergeIntoCatalog(byId, upstreamsByPublicId, upstream, providerModel, providerModel.id);
      }
    }
  }

  // TODO: surface `failedUpstreams` on each listing endpoint's wire response
  // so partial-listing failures reach clients.
  return { models: [...byId.values()].sort((a, b) => compareModelIds(a.id, b.id)), upstreamsByPublicId, failedUpstreams };
};

// How many catalog entries this upstream's stored catalog would surface, under
// the surfacing rules the loop above applies: an operator-disabled id
// contributes nothing, and a prefix policy contributes one entry per listed
// form. Null when the row holds no catalog written under the current revision.
//
// Disabled upstreams retain their last catalog size for the dashboard.
export const storedCatalogSize = (record: UpstreamRecord): number | null => {
  const cache = record.modelsCache;
  if (cache?.revision !== MODEL_CATALOG_REVISION) return null;
  const disabled = new Set(record.disabledPublicModelIds);
  const surfacedForms = record.modelPrefix?.listed.length ?? 1;
  return cache.models.filter(model => model.id && !disabled.has(model.id)).length * surfacedForms;
};

// Public-facing model-id ordering, applied to the real-model slice of the
// lists that cross a gateway boundary (the data-plane model listing on
// /v1/models, /models, and /v1beta/models, plus the control-plane /api/models
// that backs the dashboard models page). It orders that slice only: visible aliases are appended
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
