import { hashResponsesItemEncryptedContent, isStoredResponsesItemId, responsesItemEncryptedContent, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ChatServeFailure } from '../../shared/errors.ts';
import type { RoutingDecision } from '../../shared/routing.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ProviderCandidate } from '@floway-dev/provider';
import type { ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

type StoredResponsesAffinity = 'forcing' | 'portable' | 'downgradable' | 'non_affinity';

interface ResolvedStoredResponsesItemRef {
  type: string;
  id?: string;
  encryptedContent?: string;
  row?: StoredResponsesItem;
  affinity?: StoredResponsesAffinity;
}

const isUpstreamOwned = (row: StoredResponsesItem): row is StoredResponsesItem & { upstreamId: string } =>
  row.upstreamId !== null;

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
    // insertion order; orderCandidatesByStoredResponsesAffinity reverses this
    // set, sorting that upstream first.
    preferred.delete(ref.row.upstreamId);
    preferred.add(ref.row.upstreamId);
  }
  return preferred;
};

const findUnexpandedItemReferenceForcingId = (
  references: readonly ResolvedStoredResponsesItemRef[],
  upstreamId: string,
): string | null =>
  references.find(ref =>
    ref.affinity === 'forcing'
    && ref.type === 'item_reference'
    && ref.row?.upstreamId === upstreamId
    && ref.row.payload === null)?.id ?? null;

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
    if (item.type === 'item_reference') {
      // `ResponsesItemReference` requires `id` at the protocol level, so an
      // `item_reference` source item without one is a visitor bug.
      if (id === null) throw new Error('item_reference without an id reached collectStoredResponsesItemRefs');
      references.push({ type: 'item_reference', id });
      return;
    }
    references.push({
      type: item.type,
      ...(id !== null ? { id } : {}),
      ...(encryptedContent !== null ? { encryptedContent } : {}),
    });
  });

  return references;
};

const orderCandidatesByStoredResponsesAffinity = (
  candidates: readonly ProviderCandidate[],
  preferredUpstreamIds: ReadonlySet<string>,
): readonly ProviderCandidate[] => {
  const preferred = [...preferredUpstreamIds].reverse();
  if (preferred.length === 0) return candidates;

  const order = new Map(preferred.map((upstreamId, index) => [upstreamId, index]));
  const preferredCandidates = candidates
    .filter(cand => order.has(cand.provider.upstream))
    .toSorted((a, b) => order.get(a.provider.upstream)! - order.get(b.provider.upstream)!);
  const remainingCandidates = candidates.filter(cand => !order.has(cand.provider.upstream));
  return [...preferredCandidates, ...remainingCandidates];
};

export const classifyResponsesItemAffinity = async <TSourceItems>(input: {
  sourceItems: TSourceItems;
  view: ResponsesItemsView<TSourceItems>;
  store: StatefulResponsesStore;
  candidates: readonly ProviderCandidate[];
  // Items the caller will stage as inputs after the affinity walk; passed
  // here so `loadInputItems` can pre-load any stored row whose content hash
  // matches one of them. Without this, a duplicate user message resent on
  // a later turn cannot be reused — it would mint a fresh row each time.
  inputItemsToStage?: readonly ResponsesInputItem[];
}): Promise<RoutingDecision> => {
  const { sourceItems, view, store, candidates, inputItemsToStage } = input;
  await store.loadInputItems({
    sourceItems,
    view,
    inputItemsToStage,
  });
  const references = await collectStoredResponsesItemRefs(sourceItems, view);

  const queryableIds = new Set(references.flatMap(ref => ref.id !== undefined && isStoredResponsesItemId(ref.id) ? [ref.id] : []));
  const hashByContent = new Map(await Promise.all(
    [...new Set(references.flatMap(ref => ref.encryptedContent !== undefined ? [ref.encryptedContent] : []))]
      .map(async content => [content, await hashResponsesItemEncryptedContent(content)] as const),
  ));

  const failures: ChatServeFailure[] = [];
  for (const ref of references) {
    const row = (ref.id !== undefined ? store.getItemById(ref.id) : undefined)
      ?? (ref.encryptedContent !== undefined
        ? (() => {
            const hashMatches = store.getItemsByEncryptedContentHash(hashByContent.get(ref.encryptedContent)!);
            return hashMatches.find(r => ref.type === 'item_reference' || r.itemType === ref.type) ?? hashMatches[0];
          })()
        : undefined);
    if (row === undefined) {
      if (ref.type === 'item_reference') {
        // collectStoredResponsesItemRefs guarantees item_reference rows carry an id.
        if (ref.id === undefined) throw new Error('item_reference ref reached affinity walk without an id');
        failures.push({ kind: 'item-not-found', itemId: ref.id });
      } else if (ref.id !== undefined && queryableIds.has(ref.id)) {
        failures.push({ kind: 'item-not-found', itemId: ref.id });
      }
      continue;
    }

    store.touchItem(row.id);
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

  if (failures.length > 0) return { kind: 'failure', failure: failures[0] };

  const forcingUpstreamList = [...collectForcingUpstreams(references)];

  if (forcingUpstreamList.length > 1) {
    return {
      kind: 'failure',
      failure: {
        kind: 'routing-unavailable',
        message: `Stored Responses items in this request require multiple incompatible upstreams: ${forcingUpstreamList.map(id => `'${id}'`).join(', ')}.`,
      },
    };
  }

  if (forcingUpstreamList.length === 1) {
    const [upstreamId] = forcingUpstreamList;
    const matching = candidates.filter(cand => cand.provider.upstream === upstreamId);
    if (matching.length === 0) {
      return {
        kind: 'failure',
        failure: {
          kind: 'routing-unavailable',
          message: `Stored Responses items in this request require upstream '${upstreamId}', which is not available for the selected model.`,
        },
      };
    }
    const unexpandedReferenceId = findUnexpandedItemReferenceForcingId(references, upstreamId);
    if (unexpandedReferenceId !== null) {
      const itemReferenceCapable = matching.filter(cand => cand.provider.supportsResponsesItemReference);
      if (itemReferenceCapable.length === 0) {
        return { kind: 'failure', failure: { kind: 'item-not-found', itemId: unexpandedReferenceId } };
      }
      return { kind: 'success', candidates: itemReferenceCapable };
    }
    return { kind: 'success', candidates: matching };
  }

  const preferredUpstreamIds = collectPreferredUpstreams(references);
  return { kind: 'success', candidates: orderCandidatesByStoredResponsesAffinity(candidates, preferredUpstreamIds) };
};
