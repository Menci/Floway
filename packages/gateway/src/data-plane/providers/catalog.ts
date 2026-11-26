import { unionEndpoints } from './endpoint-union.ts';
import { kindForEndpoints, type OpaqueBlobCompatibilityScope } from '@floway-dev/protocols/common';
import type { InternalModel, ProviderModel, UpstreamChatModelConfig, UpstreamProviderKind } from '@floway-dev/provider';

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
  models: readonly ProviderModel[],
): UpstreamChatModelConfig | undefined => {
  const chatModels = models.filter(model => model.kind === 'chat');
  if (chatModels.length === 0) return first;
  return {
    ...(first ?? {}),
    image_detail_original: chatModels.every(model => model.chat?.image_detail_original === true),
  };
};

const internalModelFromSingle = (providerModel: ProviderModel, publicId: string): InternalModel => {
  const {
    providerData: _providerData,
    upstreamModelId: _upstreamModelId,
    enabledFlags: _enabledFlags,
    flagOverrides: _flagOverrides,
    rerankTarget: _rerankTarget,
    decisionTarget: _decisionTarget,
    endpoints,
    ...metadata
  } = providerModel;
  const chat = mergedChatMetadata(providerModel.chat, [providerModel]);
  return {
    ...metadata,
    id: publicId,
    ...(chat === undefined ? {} : { chat }),
    endpoints: { ...endpoints },
  };
};

export interface CatalogAccumulator {
  readonly byId: Map<string, InternalModel>;
  readonly contributionsById: Map<string, ModelContribution[]>;
}

export const createCatalogAccumulator = (): CatalogAccumulator => ({
  byId: new Map(),
  contributionsById: new Map(),
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
    acc.byId.set(publicId, internalModelFromSingle(surfacedModel, publicId));
    acc.contributionsById.set(publicId, [{ upstream, model: surfacedModel }]);
    return;
  }
  const contributions = acc.contributionsById.get(publicId)!;
  contributions.push({ upstream, model: surfacedModel });

  const allModels = contributions.map(entry => entry.model);
  const endpoints = unionEndpoints([existing.endpoints, surfacedModel.endpoints]);
  const chat = mergedChatMetadata(existing.chat ?? surfacedModel.chat, allModels);
  acc.byId.set(publicId, {
    ...existing,
    ...(chat === undefined ? {} : { chat }),
    opaqueBlobCompatibilityScope: mergedOpaqueBlobCompatibilityScope(allModels),
    endpoints,
    kind: kindForEndpoints(endpoints),
  });
};

export const distinctUpstreamsFromContributions = (
  contributions: readonly ModelContribution[],
): CatalogUpstreamMeta[] => {
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
export const compareModelIds = (a: string, b: string): number =>
  compareSortKeys(modelIdSortKey(a), modelIdSortKey(b));

export const sortByModelId = <T>(items: readonly T[], idOf: (item: T) => string): T[] =>
  items
    .map(item => ({ item, key: modelIdSortKey(idOf(item)) }))
    .sort((left, right) => compareSortKeys(left.key, right.key))
    .map(entry => entry.item);
