import { unionEndpoints } from './endpoint-union.ts';
import { kindForEndpoints, type OpaqueBlobCompatibilityScope } from '@floway-dev/protocols/common';
import type { InternalModel, ProviderModel, UpstreamChatModelConfig, UpstreamProviderKind } from '@floway-dev/provider';

export interface CatalogUpstreamMeta {
  readonly id: string;
  readonly kind: UpstreamProviderKind;
  readonly name: string;
  readonly hue: number;
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

// Lift a provider-emitted `ProviderModel` into an `InternalModel`, seeding
// `providerModels` with the sole entry keyed on the emitting upstream id.
// The provider model is stored verbatim under that entry so dispatch hands
// the same reference back to the provider's `callXxx`.
export const internalModelFromProviderModel = (providerModel: ProviderModel, upstreamId: string): InternalModel => {
  const { providerData, upstreamModelId: _upstreamModelId, enabledFlags, flagOverrides, rerankTarget: _rerankTarget, decisionTarget: _decisionTarget, endpoints, ...metadata } = providerModel;
  const providerModels = { [upstreamId]: providerModel };
  const chat = mergedChatMetadata(providerModel.chat, [providerModel]);
  return {
    ...metadata,
    ...(chat === undefined ? {} : { chat }),
    endpoints: { ...endpoints },
    providerModels,
  };
};

export interface CatalogAccumulator {
  readonly byId: Map<string, InternalModel>;
  readonly upstreamsByPublicId: Map<string, CatalogUpstreamMeta[]>;
  readonly contributionsByPublicId: Map<string, Map<string, ProviderModel[]>>;
}

export const createCatalogAccumulator = (): CatalogAccumulator => ({
  byId: new Map(),
  upstreamsByPublicId: new Map(),
  contributionsByPublicId: new Map(),
});

// When multiple upstreams (or multiple kinds on one upstream) expose the same
// surfaced model id, the first wins for metadata and later ones union-merge
// their endpoint capability map. `chat.image_detail_original` is the safety
// exception: it is true only when every chat contribution explicitly accepts it.
// `kind` is recomputed from the union so a chat-only id that later acquires an
// embedding-capable contribution gets correctly reclassified. When one upstream
// contributes several kinds under the same public id, `providerModels[id]` keeps
// the chat contribution ahead of non-chat ones (so Codex synthesis sees the chat
// row) while `contributionsByPublicId` retains every contribution for rebuilding
// authorized subsets.
export const mergeIntoCatalog = (
  acc: CatalogAccumulator,
  upstream: CatalogUpstreamMeta,
  surfacedModel: ProviderModel,
  publicId: string,
): void => {
  const existing = acc.byId.get(publicId);
  if (!existing) {
    acc.byId.set(publicId, internalModelFromProviderModel(surfacedModel, upstream.id));
    acc.upstreamsByPublicId.set(publicId, [upstream]);
    acc.contributionsByPublicId.set(publicId, new Map([[upstream.id, [surfacedModel]]]));
    return;
  }
  if (existing.providerModels === undefined) {
    throw new Error(`mergeIntoCatalog: catalog row for '${publicId}' unexpectedly carries aliasedFrom instead of providerModels`);
  }
  const byUpstream = acc.contributionsByPublicId.get(publicId);
  if (byUpstream === undefined) throw new Error(`invariant broken: contributionsByPublicId missing ${publicId}`);
  const upstreamList = byUpstream.get(upstream.id);
  if (upstreamList === undefined) {
    byUpstream.set(upstream.id, [surfacedModel]);
  } else {
    upstreamList.push(surfacedModel);
  }

  const allModels = [...byUpstream.values()].flat();
  const endpoints = unionEndpoints([existing.endpoints, surfacedModel.endpoints]);
  const currentSlot = existing.providerModels[upstream.id];
  const preferredSlot = currentSlot?.kind === 'chat' && surfacedModel.kind !== 'chat'
    ? currentSlot
    : surfacedModel;
  const providerModels = {
    ...existing.providerModels,
    [upstream.id]: preferredSlot,
  };
  const chat = mergedChatMetadata(existing.chat ?? surfacedModel.chat, allModels);
  acc.byId.set(publicId, {
    ...existing,
    ...(chat === undefined ? {} : { chat }),
    opaqueBlobCompatibilityScope: mergedOpaqueBlobCompatibilityScope(allModels),
    endpoints,
    kind: kindForEndpoints(endpoints),
    providerModels,
  });

  const upstreams = acc.upstreamsByPublicId.get(publicId);
  if (upstreams === undefined) throw new Error(`invariant broken: upstreamsByPublicId missing ${publicId}`);
  if (!upstreams.some(item => item.id === upstream.id)) {
    upstreams.push(upstream);
  }
};

// Public-facing model-id ordering, applied to the real-model slice of the
// lists that cross a gateway boundary (the data-plane model listing on
// /v1/models, /models, and /v1beta/models, plus the control-plane /api/models
// that backs the dashboard models page). It orders that slice only: visible
// aliases are appended afterwards in alias `sortOrder`, and
// `/api/models?include_unlisted=true` appends the unlisted rows after the
// listed ones.
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
