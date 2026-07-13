import { createTemporaryResponsesItemId, responsesItemEncryptedContent, responsesItemId } from './format.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItemMetadata, StoredResponsesItemPayload } from '../../../../repo/types.ts';
import { throwChatServeFailure } from '../../shared/errors.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';
import type { CanonicalResponsesPayload, ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const isUpstreamOwned = (row: StoredResponsesItemMetadata): row is StoredResponsesItemMetadata & { upstreamId: string } =>
  row.upstreamId !== null;

const itemWithId = (item: ResponsesInputItem, id: string): ResponsesInputItem => ({
  ...item,
  id,
} as ResponsesInputItem);

// Codex stores output items in an input-shaped history model: message/function
// status and output-text annotations/logprobs are absent, while reasoning keeps
// an optional content carrier. Restore the server defaults only for the durable
// content-hash comparison; the normalized object is used only when that hash
// proves it is exactly the persisted canonical payload.
// https://github.com/openai/codex/blob/c888e8e75a9f0e90ce7d5517f8b9540832cbbf76/codex-rs/protocol/src/models.rs#L843-L858
// https://github.com/openai/codex/blob/c888e8e75a9f0e90ce7d5517f8b9540832cbbf76/codex-rs/protocol/src/models.rs#L933-L1012
const canonicalStoredEcho = (item: ResponsesInputItem, row: StoredResponsesItemMetadata): ResponsesInputItem => {
  const canonical = structuredClone(item) as ResponsesInputItem & Record<string, unknown>;
  if (row.upstreamItemId !== null) canonical.id = row.upstreamItemId;
  if (canonical.type === 'reasoning' && canonical.content == null) canonical.content = [];
  if ((canonical.type === 'function_call' || canonical.type === 'message') && canonical.status === undefined) {
    canonical.status = 'completed';
  }
  if (canonical.type === 'message' && Array.isArray(canonical.content)) {
    canonical.content = canonical.content.map(block => {
      if (block.type !== 'output_text') return block;
      return {
        ...block,
        ...(!Object.hasOwn(block, 'annotations') ? { annotations: [] } : {}),
        ...(!Object.hasOwn(block, 'logprobs') ? { logprobs: [] } : {}),
      };
    });
  }
  return canonical;
};

interface ResolvedItem {
  readonly item: ResponsesInputItem;
  readonly row?: StoredResponsesItemMetadata;
  canonical?: ResponsesInputItem;
}

const resolveStoredRow = (
  item: ResponsesInputItem,
  store: StatefulResponsesStore,
  hashByEncryptedContent: ReadonlyMap<string, string>,
): StoredResponsesItemMetadata | undefined => {
  const id = responsesItemId(item);
  const encryptedContent = responsesItemEncryptedContent(item);
  return (id !== null ? store.getItemById(id) : undefined)
    ?? (encryptedContent !== null ? store.getItemsByEncryptedContentHash(hashByEncryptedContent.get(encryptedContent)!).find(
      row => item.type === 'item_reference' || row.itemType === item.type,
    ) ?? store.getItemsByEncryptedContentHash(hashByEncryptedContent.get(encryptedContent)!)[0] : undefined);
};

const shouldHydrate = async (
  resolved: ResolvedItem,
  candidate: ModelCandidate,
  store: StatefulResponsesStore,
): Promise<boolean> => {
  const { item, row } = resolved;
  if (!row?.hasPayload) return false;
  if (isUpstreamOwned(row) && row.itemType === 'reasoning' && row.upstreamId !== candidate.provider.upstream) return false;
  if (item.type === 'item_reference') return true;
  if (row.origin === 'synthetic') return true;
  const canonical = canonicalStoredEcho(item, row);
  if (row.contentHash !== null && await store.hashItemContent(canonical) === row.contentHash) {
    resolved.canonical = canonical;
    return false;
  }
  return true;
};

const rewriteItemForCandidate = (
  resolved: ResolvedItem,
  payload: StoredResponsesItemPayload | undefined,
  candidate: ModelCandidate,
): ResponsesInputItem | null => {
  const { item, row } = resolved;
  if (row === undefined) {
    if (item.type === 'item_reference') throwChatServeFailure({ kind: 'item-not-found', itemId: item.id });
    return item;
  }
  if (item.type === 'item_reference' && !row.hasPayload) {
    throwChatServeFailure({ kind: 'item-not-found', itemId: row.id });
  }
  if (isUpstreamOwned(row) && row.itemType === 'reasoning' && row.upstreamId !== candidate.provider.upstream) return null;
  if (item.type === 'item_reference' && payload === undefined) {
    throwChatServeFailure({ kind: 'item-not-found', itemId: row.id });
  }
  const replacement = resolved.canonical
    ?? (payload === undefined ? item : structuredClone(payload.item) as ResponsesInputItem);
  if (!isUpstreamOwned(row)) return replacement;
  if (row.upstreamId === candidate.provider.upstream && row.upstreamItemId !== null) {
    return itemWithId(replacement, row.upstreamItemId);
  }
  if (responsesItemId(replacement) !== null) return itemWithId(replacement, createTemporaryResponsesItemId(row.itemType));
  return replacement;
};

const collectEncryptedContents = async (
  items: Iterable<ResponsesInputItem>,
  store: StatefulResponsesStore,
): Promise<Map<string, string>> => {
  const encryptedContents = new Set<string>();
  for (const item of items) {
    const encryptedContent = responsesItemEncryptedContent(item);
    if (encryptedContent !== null) encryptedContents.add(encryptedContent);
  }
  return new Map(await Promise.all([...encryptedContents].map(async value => [value, await store.hashEncryptedContent(value)] as const)));
};

const rewriteResponsesItemListForCandidate = async (
  items: readonly ResponsesInputItem[],
  store: StatefulResponsesStore,
  candidate: ModelCandidate,
): Promise<{ readonly items: Array<ResponsesInputItem | null>; readonly privatePayloads: ReadonlyMap<string, unknown> }> => {
  const hashByEncryptedContent = await collectEncryptedContents(items, store);
  const resolved = items.map(item => ({ item, row: resolveStoredRow(item, store, hashByEncryptedContent) }));
  const rowsToHydrate: StoredResponsesItemMetadata[] = [];
  for (const item of resolved) {
    if (await shouldHydrate(item, candidate, store) && item.row !== undefined) rowsToHydrate.push(item.row);
  }
  const payloads = await store.loadItemPayloads(rowsToHydrate);
  const privatePayloads = new Map<string, unknown>();
  const rewritten = resolved.map(item => {
    const payload = item.row === undefined ? undefined : payloads.get(item.row.id);
    const result = rewriteItemForCandidate(item, payload, candidate);
    const wireId = result === null ? null : responsesItemId(result);
    if (wireId !== null && payload?.private !== undefined) privatePayloads.set(wireId, structuredClone(payload.private));
    return result;
  });
  // The outbound objects no longer need hashes from their source inputs. Drop
  // those values before the upstream wait; output persistence starts a fresh
  // cache through the same turn-local store.
  store.clearItemHashes();
  return { items: rewritten, privatePayloads };
};

export interface RewrittenResponsesPayload {
  readonly payload: CanonicalResponsesPayload;
  readonly privatePayloads: ReadonlyMap<string, unknown>;
}

export const rewriteResponsesPayloadForCandidate = async (
  payload: CanonicalResponsesPayload,
  store: StatefulResponsesStore,
  candidate: ModelCandidate,
): Promise<RewrittenResponsesPayload> => {
  const rewritten = await rewriteResponsesItemListForCandidate(payload.input, store, candidate);
  return { payload: { ...payload, input: rewritten.items.filter(item => item !== null) }, privatePayloads: rewritten.privatePayloads };
};

export const rewriteStoredItemsInSourceForCandidate = async <TSourceItems>(
  sourceItems: TSourceItems,
  view: ResponsesItemsView<TSourceItems>,
  store: StatefulResponsesStore,
  candidate: ModelCandidate,
): Promise<TSourceItems> => {
  const visited: ResponsesInputItem[] = [];
  await view.visitAsResponsesItems(sourceItems, item => { visited.push(item); });
  const rewritten = await rewriteResponsesItemListForCandidate(visited, store, candidate);
  let index = 0;
  return (await view.mapAsResponsesItems(sourceItems, () => rewritten.items[index++])) as TSourceItems;
};
