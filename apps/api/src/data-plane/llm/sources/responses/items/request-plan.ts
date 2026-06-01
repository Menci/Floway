import { createTemporaryResponsesItemId, hashResponsesItemEncryptedContent, isStoredResponsesItemId, responsesItemEncryptedContent, responsesItemId } from './format.ts';
import { getRepo } from '../../../../../repo/index.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import type { ModelProviderInstance, ProviderModelRecord } from '../../../../providers/types.ts';
import { throwLlmServeFailure, type LlmServeFailure } from '../../traits.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { Mutable, ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export type StoredResponsesAffinity = 'forcing' | 'portable' | 'downgradable' | 'non_affinity';

// A request item that points at a stored row. `id` and `encryptedContent` are
// equivalent lookup keys: a gateway id when the client echoed one, the opaque
// reasoning/compaction blob when it did not (Codex strips ids on the wire).
export interface StoredResponsesItemRef {
  type: string;
  id?: string;
  encryptedContent?: string;
}

// A reference resolved during preparation: the stored row it points at (absent
// for a benign miss) and the routing affinity it imposes.
export interface ResolvedStoredResponsesItemRef extends StoredResponsesItemRef {
  row?: StoredResponsesItem;
  affinity?: StoredResponsesAffinity;
}

// Stored-item routing only ever diagnoses these two failures of the wider
// serve-failure union; model and internal failures arise later, in the
// provider walk and the top-level catch.
export type StoredResponsesItemsFailure = Extract<LlmServeFailure, { kind: 'item-not-found' | 'routing-unavailable' }>;

export interface PreparedStoredResponsesItems {
  references: ResolvedStoredResponsesItemRef[];
  failures: StoredResponsesItemsFailure[];
  forcingUpstreamIds: ReadonlySet<string>;
  preferredUpstreamIds: ReadonlySet<string>;
}

export type StoredResponsesProviderPlan =
  | { type: 'providers'; providers: readonly ModelProviderInstance[] }
  | { type: 'failure'; failure: StoredResponsesItemsFailure };

// A stored row either belongs to the upstream that produced it — native
// Responses upstreams hand back their own item ids — or is gateway-synthesized
// from a non-Responses upstream, in which case it has no upstream identity.
// Owned rows carry routing affinity tied to their origin; synthetic rows are
// freely portable and inline-expanded to whichever upstream serves the request.
const isUpstreamOwned = (row: StoredResponsesItem): row is StoredResponsesItem & { upstreamId: string } => row.upstreamId !== null;

export const prepareStoredResponsesItemsForSource = async <TSourceItems>(
  sourceItems: TSourceItems,
  apiKeyId: string | null,
  view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>,
): Promise<PreparedStoredResponsesItems> => {
  const references = await collectStoredResponsesItemRefs(sourceItems, view);

  // id and encrypted_content are equivalent lookup keys, so resolve both at
  // once and merge. `isStoredResponsesItemId` decides which ids are even
  // queryable here, exactly once.
  const queryableIds = new Set(references.flatMap(ref => ref.id !== undefined && isStoredResponsesItemId(ref.id) ? [ref.id] : []));
  const hashByContent = new Map(await Promise.all(
    [...new Set(references.flatMap(ref => ref.encryptedContent !== undefined ? [ref.encryptedContent] : []))]
      .map(async content => [content, await hashResponsesItemEncryptedContent(content)] as const),
  ));
  const [byId, byHash] = await Promise.all([
    getRepo().responsesItems.lookupMany(apiKeyId, [...queryableIds]),
    getRepo().responsesItems.lookupManyByEncryptedContentHash(apiKeyId, [...new Set(hashByContent.values())]),
  ]);
  const rowById = new Map(byId.map(row => [row.id, row]));
  const rowByHash = new Map(byHash.flatMap(row => row.encryptedContentHash !== null ? [[row.encryptedContentHash, row] as const] : []));

  const failures: StoredResponsesItemsFailure[] = [];
  for (const ref of references) {
    const row = (ref.id !== undefined ? rowById.get(ref.id) : undefined)
      ?? (ref.encryptedContent !== undefined ? rowByHash.get(hashByContent.get(ref.encryptedContent)!) : undefined);
    if (row === undefined) {
      // `item_reference` asserts a stored row, and a parseable gateway id names
      // one too, so either resolving to nothing is a hard not-found. An id-less
      // blob that matches nothing is benign — a fresh or foreign reasoning.
      if (ref.type === 'item_reference' || (ref.id !== undefined && queryableIds.has(ref.id))) {
        failures.push({ kind: 'item-not-found', itemId: ref.id ?? '' });
      }
      continue;
    }

    ref.row = row;
    if (ref.type === 'item_reference' && row.payload === null && row.upstreamItemId === null) {
      failures.push({ kind: 'item-not-found', itemId: row.id });
      continue;
    }
    if (ref.type !== 'item_reference' && ref.type !== row.itemType) {
      failures.push({
        kind: 'routing-unavailable',
        message: `Stored Responses item '${row.id}' has type '${row.itemType}', incompatible with the requested item type '${ref.type}'.`,
      });
      continue;
    }
    ref.affinity = classifyStoredResponsesAffinity(ref.type, row);
    if (ref.affinity === 'forcing' && !isUpstreamOwned(row)) {
      failures.push({ kind: 'item-not-found', itemId: row.id });
    }
  }

  return {
    references,
    failures,
    forcingUpstreamIds: collectForcingUpstreams(references),
    preferredUpstreamIds: collectPreferredUpstreams(references),
  };
};

export const planResponsesItemProviders = (
  providers: readonly ModelProviderInstance[],
  prepared: PreparedStoredResponsesItems,
): StoredResponsesProviderPlan => {
  if (prepared.failures.length > 0) return { type: 'failure', failure: prepared.failures[0] };

  const forcingUpstreamIds = [...prepared.forcingUpstreamIds];
  if (forcingUpstreamIds.length > 1) {
    return {
      type: 'failure',
      failure: {
        kind: 'routing-unavailable',
        message: `Stored Responses items in this request require multiple incompatible upstreams: ${forcingUpstreamIds.map(id => `'${id}'`).join(', ')}.`,
      },
    };
  }

  if (forcingUpstreamIds.length === 1) {
    const [upstreamId] = forcingUpstreamIds;
    const matching = providers.filter(provider => provider.upstream === upstreamId);
    if (matching.length === 0) {
      return {
        type: 'failure',
        failure: {
          kind: 'routing-unavailable',
          message: `Stored Responses items in this request require upstream '${upstreamId}', which is not available for the selected model.`,
        },
      };
    }
    const unexpandedReferenceId = findUnexpandedItemReferenceForcingId(prepared, upstreamId);
    if (unexpandedReferenceId !== null) {
      const itemReferenceCapable = matching.filter(provider => provider.supportsResponsesItemReference);
      if (itemReferenceCapable.length === 0) {
        return { type: 'failure', failure: { kind: 'item-not-found', itemId: unexpandedReferenceId } };
      }
      return { type: 'providers', providers: itemReferenceCapable };
    }
    return { type: 'providers', providers: matching };
  }

  return { type: 'providers', providers: orderProvidersByStoredResponsesAffinity(providers, prepared) };
};

export const orderProvidersByStoredResponsesAffinity = (
  providers: readonly ModelProviderInstance[],
  prepared: PreparedStoredResponsesItems,
): readonly ModelProviderInstance[] => {
  const preferred = [...prepared.preferredUpstreamIds].reverse();
  if (preferred.length === 0) return providers;

  const order = new Map(preferred.map((upstreamId, index) => [upstreamId, index]));
  const preferredProviders = providers
    .filter(provider => order.has(provider.upstream))
    .toSorted((a, b) => order.get(a.upstream)! - order.get(b.upstream)!);
  const remainingProviders = providers.filter(provider => !order.has(provider.upstream));
  return [...preferredProviders, ...remainingProviders];
};

export const rewriteStoredResponsesItemsForProvider = async <TSourceItems>(
  sourceItems: TSourceItems,
  prepared: PreparedStoredResponsesItems,
  provider: ProviderModelRecord,
  view: ResponsesItemsView<TSourceItems>,
): Promise<Mutable<TSourceItems>> => {
  const [failure] = prepared.failures;
  if (failure) throwLlmServeFailure(failure);
  const rowById = new Map(prepared.references.flatMap(ref => ref.id !== undefined && ref.row ? [[ref.id, ref.row] as const] : []));
  const rowByEncryptedContent = new Map(prepared.references.flatMap(ref => ref.encryptedContent !== undefined && ref.row ? [[ref.encryptedContent, ref.row] as const] : []));
  return await view.mapAsResponsesItems(sourceItems, item => rewriteStoredResponsesItemForProvider(item, rowById, rowByEncryptedContent, provider));
};

// Each request item resolves to its stored row by the same keys preparation
// used — gateway id or `encrypted_content` blob, matched verbatim, no re-hash.
const collectStoredResponsesItemRefs = async <TSourceItems>(
  sourceItems: TSourceItems,
  view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>,
): Promise<ResolvedStoredResponsesItemRef[]> => {
  const references: ResolvedStoredResponsesItemRef[] = [];

  await view.visitAsResponsesItems(sourceItems, item => {
    const id = responsesItemId(item);
    const encryptedContent = responsesItemEncryptedContent(item);
    // A reference is anything that could name a stored row — an id (a gateway
    // id, or an `item_reference` asserting one) or an `encrypted_content` blob.
    // Items that carry their own inline content with neither pass through.
    if (id === null && encryptedContent === null) return;
    references.push({
      type: item.type,
      ...(id !== null ? { id } : {}),
      ...(encryptedContent !== null ? { encryptedContent } : {}),
    });
  });

  return references;
};

const collectForcingUpstreams = (
  references: readonly ResolvedStoredResponsesItemRef[],
): ReadonlySet<string> => {
  const upstreams = new Set<string>();
  for (const ref of references) {
    if (ref.affinity !== 'forcing' || !ref.row?.upstreamId) continue;
    upstreams.add(ref.row.upstreamId);
  }
  return upstreams;
};

const collectPreferredUpstreams = (
  references: readonly ResolvedStoredResponsesItemRef[],
): ReadonlySet<string> => {
  const preferred = new Set<string>();
  for (const ref of references) {
    if (ref.affinity !== 'portable' && ref.affinity !== 'downgradable') continue;
    if (!ref.row || !isUpstreamOwned(ref.row)) continue;
    // Re-insert so the most-recently-referenced upstream lands last in
    // insertion order; orderProvidersByStoredResponsesAffinity reverses this
    // set, sorting that upstream first.
    preferred.delete(ref.row.upstreamId);
    preferred.add(ref.row.upstreamId);
  }
  return preferred;
};

const findUnexpandedItemReferenceForcingId = (
  prepared: PreparedStoredResponsesItems,
  upstreamId: string,
): string | null =>
  prepared.references.find(ref =>
    ref.affinity === 'forcing'
    && ref.type === 'item_reference'
    && ref.row?.upstreamId === upstreamId
    && ref.row.payload === null)?.id ?? null;

const classifyStoredResponsesAffinity = (
  itemType: string,
  row: StoredResponsesItem,
): StoredResponsesAffinity => {
  if (itemType === 'item_reference' && row.payload === null) return 'forcing';
  if (!isUpstreamOwned(row)) return 'non_affinity';
  if (row.itemType === 'compaction') return 'forcing';
  if (row.itemType === 'reasoning') return 'downgradable';
  return 'portable';
};

const rewriteStoredResponsesItemForProvider = (
  item: ResponsesInputItem,
  rowById: ReadonlyMap<string, StoredResponsesItem>,
  rowByEncryptedContent: ReadonlyMap<string, StoredResponsesItem>,
  provider: ProviderModelRecord,
): ResponsesInputItem | null => {
  const id = responsesItemId(item);
  const encryptedContent = responsesItemEncryptedContent(item);
  const row = (id !== null ? rowById.get(id) : undefined)
    ?? (encryptedContent !== null ? rowByEncryptedContent.get(encryptedContent) : undefined);
  if (row === undefined) return item;

  // An `item_reference` whose stored row has no inline payload can only
  // travel as a reference on the wire; a provider that doesn't support
  // `item_reference` input has no way to expand it.
  if (item.type === 'item_reference' && row.payload === null && !provider.supportsResponsesItemReference) {
    throwLlmServeFailure({ kind: 'item-not-found', itemId: row.id });
  }

  if (!isUpstreamOwned(row)) {
    // Synthetic rows have no owning upstream and stay portable to any
    // provider. Inline-expand from the stored payload and preserve
    // `payload.item.id` verbatim so the wire id matches what the per-attempt
    // `privatePayload` seed reads — source interceptors look the payload up
    // by whatever id the rewriter puts on the wire, no rewriter-side stash.
    return storedItemReplacementBase(item, row);
  }

  // Owned reasoning is bound to the upstream that produced it; drop it when
  // routing elsewhere.
  if (row.itemType === 'reasoning' && row.upstreamId !== provider.upstream) return null;

  if (row.upstreamId === provider.upstream && row.upstreamItemId) {
    // Same upstream: substitute the original upstream-issued id. A
    // reference-capable provider keeps the wire item as `item_reference`;
    // others inline-expand against the stored payload.
    return item.type === 'item_reference' && provider.supportsResponsesItemReference
      ? itemWithId(item, row.upstreamItemId)
      : itemWithId(storedItemReplacementBase(item, row), row.upstreamItemId);
  }

  // Cross-upstream owned: mint a tmp id so the foreign upstream's id
  // namespace can't bleed into the new upstream's view.
  const replacement = storedItemReplacementBase(item, row);
  if (responsesItemId(replacement) !== null) return itemWithId(replacement, createTemporaryResponsesItemId(row.itemType));
  return replacement;
};

const storedItemReplacementBase = (
  item: ResponsesInputItem,
  row: StoredResponsesItem,
): ResponsesInputItem => {
  // The caller hands us items it already owns (the per-attempt payload clone),
  // so the no-stored-payload branch may reuse `item` directly. The stored row,
  // by contrast, lives in the shared lookup cache and is cloned so downstream
  // interceptor mutation cannot corrupt it across the request.
  if (row.payload === null) return item;
  return structuredClone(row.payload.item) as ResponsesInputItem;
};

const itemWithId = (item: ResponsesInputItem, id: string): ResponsesInputItem => ({
  ...item,
  id,
} as ResponsesInputItem);
