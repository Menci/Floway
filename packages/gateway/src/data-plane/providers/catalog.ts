import { kindForEndpoints, type ModelEndpointKey, type OpaqueBlobCompatibilityScope } from '@floway-dev/protocols/common';
import type { InternalModel, ProviderModel, UpstreamProviderKind } from '@floway-dev/provider';

export interface CatalogUpstreamMeta {
  readonly id: string;
  readonly kind: UpstreamProviderKind;
  readonly name: string;
  readonly hue: number;
}

export interface ModelContribution {
  readonly upstream: CatalogUpstreamMeta;
  readonly model: ProviderModel;
}

interface MergeTrackState {
  hasChat: boolean;
  allChatImageDetailOriginal: boolean;
  readonly firstScope: OpaqueBlobCompatibilityScope;
  scopeConsistent: boolean;
}

const internalModelFromSingle = (providerModel: ProviderModel, publicId: string): InternalModel => {
  const isChat = providerModel.kind === 'chat';
  const chat = isChat
    ? { ...providerModel.chat, image_detail_original: providerModel.chat?.image_detail_original === true }
    : providerModel.chat;
  const model: InternalModel = {
    id: publicId,
    limits: providerModel.limits,
    kind: providerModel.kind,
    endpoints: { ...providerModel.endpoints },
    opaqueBlobCompatibilityScope: providerModel.opaqueBlobCompatibilityScope,
  };
  if (providerModel.display_name !== undefined) model.display_name = providerModel.display_name;
  if (providerModel.owned_by !== undefined) model.owned_by = providerModel.owned_by;
  if (providerModel.created !== undefined) model.created = providerModel.created;
  if (providerModel.pricing !== undefined) model.pricing = providerModel.pricing;
  if (chat !== undefined) model.chat = chat;
  return model;
};

export interface CatalogAccumulator {
  readonly byId: Map<string, InternalModel>;
  readonly contributionsById: Map<string, ModelContribution[]>;
  readonly stateById: Map<string, MergeTrackState>;
}

export const createCatalogAccumulator = (): CatalogAccumulator => ({
  byId: new Map(),
  contributionsById: new Map(),
  stateById: new Map(),
});

// When multiple upstreams (or multiple kinds on one upstream) expose the same
// surfaced model id, the first wins for metadata and later ones union-merge
// their endpoint capability map. `chat.image_detail_original` is the safety
// exception: it is true only when every chat contribution explicitly accepts it.
// `kind` is recomputed from the union so a chat-only id that later acquires an
// embedding-capable contribution gets correctly reclassified.
export const mergeIntoCatalog = (
  acc: CatalogAccumulator,
  upstream: CatalogUpstreamMeta,
  surfacedModel: ProviderModel,
  publicId: string,
): void => {
  const existing = acc.byId.get(publicId);
  if (!existing) {
    const isChat = surfacedModel.kind === 'chat';
    acc.byId.set(publicId, internalModelFromSingle(surfacedModel, publicId));
    acc.contributionsById.set(publicId, [{ upstream, model: surfacedModel }]);
    acc.stateById.set(publicId, {
      hasChat: isChat,
      allChatImageDetailOriginal: isChat ? surfacedModel.chat?.image_detail_original === true : true,
      firstScope: surfacedModel.opaqueBlobCompatibilityScope,
      scopeConsistent: true,
    });
    return;
  }
  acc.contributionsById.get(publicId)!.push({ upstream, model: surfacedModel });
  const state = acc.stateById.get(publicId)!;

  const targetEndpoints = existing.endpoints;
  for (const key of Object.keys(surfacedModel.endpoints) as ModelEndpointKey[]) {
    const incoming = surfacedModel.endpoints[key];
    if (incoming === undefined) continue;
    const prior = targetEndpoints[key];
    targetEndpoints[key] = prior === undefined ? { ...incoming } : { ...prior, ...incoming };
  }
  existing.kind = kindForEndpoints(targetEndpoints);

  if (existing.chat === undefined && surfacedModel.chat !== undefined) {
    existing.chat = surfacedModel.chat;
  }
  if (surfacedModel.kind === 'chat') {
    const incomingOriginal = surfacedModel.chat?.image_detail_original === true;
    if (!state.hasChat) {
      state.hasChat = true;
      state.allChatImageDetailOriginal = incomingOriginal;
      existing.chat = { ...existing.chat, image_detail_original: incomingOriginal };
    } else if (state.allChatImageDetailOriginal && !incomingOriginal) {
      state.allChatImageDetailOriginal = false;
      existing.chat = { ...existing.chat, image_detail_original: false };
    }
  }

  if (state.scopeConsistent) {
    const incoming = surfacedModel.opaqueBlobCompatibilityScope;
    if (incoming.bindToUpstream !== state.firstScope.bindToUpstream || incoming.key !== state.firstScope.key) {
      state.scopeConsistent = false;
      existing.opaqueBlobCompatibilityScope = { bindToUpstream: true };
    }
  }
};

export const distinctUpstreamsFromContributions = (
  contributions: readonly ModelContribution[],
): CatalogUpstreamMeta[] => {
  if (contributions.length === 1) return [contributions[0]!.upstream];
  const seen = new Set<string>();
  const out: CatalogUpstreamMeta[] = [];
  for (const { upstream } of contributions) {
    if (seen.has(upstream.id)) continue;
    seen.add(upstream.id);
    out.push(upstream);
  }
  return out;
};

const PREFIX_RE = /^[a-zA-Z]+/;
const STANDALONE_DIGIT_RE = /(?<!\d)\d(?!\d)/g;

interface ModelIdSortKey {
  readonly id: string;
  readonly hasSlash: number;
  readonly prefix: string;
  readonly digits: number[];
  readonly lower: string;
}

const modelIdSortKey = (id: string): ModelIdSortKey => ({
  id,
  hasSlash: id.includes('/') ? 1 : 0,
  prefix: PREFIX_RE.exec(id)?.[0].toLowerCase() ?? '',
  digits: [...id.matchAll(STANDALONE_DIGIT_RE)].map(m => +m[0]),
  lower: id.toLowerCase(),
});

const compareSortKeys = (a: ModelIdSortKey, b: ModelIdSortKey): number => {
  if (a.hasSlash !== b.hasSlash) return a.hasSlash - b.hasSlash;
  if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
  const minLen = Math.min(a.digits.length, b.digits.length);
  for (let i = 0; i < minLen; i++) {
    const diff = b.digits[i]! - a.digits[i]!;
    if (diff !== 0) return diff;
  }
  if (a.digits.length !== b.digits.length) return b.digits.length - a.digits.length;
  if (a.lower !== b.lower) return a.lower < b.lower ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

// Public-facing model-id ordering, applied to the real-model slice of the
// lists that cross a gateway boundary (the data-plane model listing on
// /v1/models, /models, and /v1beta/models, plus the control-plane /api/models
// that backs the dashboard models page). It orders that slice only: visible
// aliases are appended afterwards in alias `sortOrder`, and
// `/api/models?include_unlisted=true` appends the unlisted rows after the
// listed ones.
export const sortByModelId = <T>(items: readonly T[], idOf: (item: T) => string): T[] =>
  items
    .map(item => ({ item, key: modelIdSortKey(idOf(item)) }))
    .sort((left, right) => compareSortKeys(left.key, right.key))
    .map(entry => entry.item);
