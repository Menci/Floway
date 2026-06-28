import { createTemporaryResponsesItemId, hashResponsesItemEncryptedContent, responsesItemEncryptedContent, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderCandidate } from '@floway-dev/provider';
import type { ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const isUpstreamOwned = (row: StoredResponsesItem): row is StoredResponsesItem & { upstreamId: string } =>
  row.upstreamId !== null;

const storedItemReplacementBase = (
  item: ResponsesInputItem,
  row: StoredResponsesItem,
): ResponsesInputItem => {
  if (row.payload === null) return item;
  return structuredClone(row.payload.item) as ResponsesInputItem;
};

const itemWithId = (item: ResponsesInputItem, id: string): ResponsesInputItem => ({
  ...item,
  id,
} as ResponsesInputItem);

const rewriteItemForCandidate = (
  item: ResponsesInputItem,
  row: StoredResponsesItem,
  candidate: ProviderCandidate,
): ResponsesInputItem | null => {
  // An `item_reference` whose stored row has no inline payload can only
  // travel as a reference on the wire; a provider that doesn't support
  // `item_reference` input has no way to expand it.
  if (item.type === 'item_reference' && row.payload === null && !candidate.provider.supportsResponsesItemReference) {
    throwChatServeFailure({ kind: 'item-not-found', itemId: row.id });
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
  if (row.itemType === 'reasoning' && row.upstreamId !== candidate.provider.upstream) return null;

  if (row.upstreamId === candidate.provider.upstream && row.upstreamItemId) {
    // Same upstream: substitute the original upstream-issued id. A
    // reference-capable provider keeps the wire item as `item_reference`;
    // others inline-expand against the stored payload.
    return item.type === 'item_reference' && candidate.provider.supportsResponsesItemReference
      ? itemWithId(item, row.upstreamItemId)
      : itemWithId(storedItemReplacementBase(item, row), row.upstreamItemId);
  }

  // Cross-upstream owned: mint a tmp id so the foreign upstream's id
  // namespace can't bleed into the new upstream's view.
  const replacement = storedItemReplacementBase(item, row);
  if (responsesItemId(replacement) !== null) return itemWithId(replacement, createTemporaryResponsesItemId(row.itemType));
  return replacement;
};

const collectEncryptedContents = async (items: Iterable<ResponsesInputItem>): Promise<Map<string, string>> => {
  const encryptedContents = new Set<string>();
  for (const item of items) {
    const enc = responsesItemEncryptedContent(item);
    if (enc !== null) encryptedContents.add(enc);
  }
  return new Map(
    await Promise.all([...encryptedContents].map(async enc => [enc, await hashResponsesItemEncryptedContent(enc)] as const)),
  );
};

export interface RewrittenResponsesReference {
  readonly row?: StoredResponsesItem;
}

export interface RewrittenResponsesPayload {
  readonly payload: ResponsesPayload;
  readonly references: ReadonlyArray<RewrittenResponsesReference>;
}

const rewriteOneItemAgainstStore = (
  item: ResponsesInputItem,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
  hashByEncryptedContent: ReadonlyMap<string, string>,
  references: RewrittenResponsesReference[],
): ResponsesInputItem | null => {
  const id = responsesItemId(item);
  const encryptedContent = responsesItemEncryptedContent(item);
  const row = (id !== null ? store.getItemById(id) : undefined)
    ?? (encryptedContent !== null ? store.getItemsByEncryptedContentHash(hashByEncryptedContent.get(encryptedContent)!).find(
      r => item.type === 'item_reference' || r.itemType === item.type,
    ) ?? store.getItemsByEncryptedContentHash(hashByEncryptedContent.get(encryptedContent)!)[0] : undefined);

  if (row === undefined) return item;
  references.push({ row });
  return rewriteItemForCandidate(item, row, candidate);
};

export const rewriteResponsesItemsForCandidate = async (
  payload: ResponsesPayload,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<RewrittenResponsesPayload> => {
  if (typeof payload.input === 'string') return { payload, references: [] };

  // Pre-compute encrypted_content hashes so each item lookup is a single
  // synchronous map access rather than a fresh hash per item.
  const hashByEncryptedContent = await collectEncryptedContents(payload.input);

  const rewritten: ResponsesInputItem[] = [];
  const references: RewrittenResponsesReference[] = [];
  for (const item of payload.input) {
    const result = rewriteOneItemAgainstStore(item, store, candidate, hashByEncryptedContent, references);
    if (result !== null) rewritten.push(result);
  }

  return { payload: { ...payload, input: rewritten }, references };
};

// Source-items rewriter for non-Responses attempts (Messages, Chat
// Completions, Gemini); per-row rewrite policy lives in rewriteItemForCandidate.
export const rewriteStoredResponsesItemsForCandidate = async <TSourceItems>(
  sourceItems: TSourceItems,
  view: ResponsesItemsView<TSourceItems>,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<TSourceItems> => {
  // Pre-compute encrypted_content hashes so the per-item walk is a single
  // synchronous lookup instead of re-hashing on every visit.
  const visited: ResponsesInputItem[] = [];
  await view.visitAsResponsesItems(sourceItems, item => { visited.push(item); });
  const hashByEncryptedContent = await collectEncryptedContents(visited);

  // Per-attempt private-payload seeding lives on the Responses-shaped variant
  // because only `responsesAttempt` runs the seed; non-Responses sources
  // discard references after the rewrite.
  const references: RewrittenResponsesReference[] = [];
  return (await view.mapAsResponsesItems(sourceItems, item =>
    rewriteOneItemAgainstStore(item, store, candidate, hashByEncryptedContent, references))) as TSourceItems;
};
