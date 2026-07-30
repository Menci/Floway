import { createResponsesStorageKey, hashResponsesItem, responsesItemId } from './identity.ts';
import { getRepo } from '../../../../repo/index.ts';
import { assertSameStoredResponsesItem, cloneStoredResponsesItem, cloneStoredResponsesSnapshot, compareResponsesItemsByFreshness, scopedResponsesKey } from '../../../../repo/responses-clone.ts';
import { quantizeResponsesRefreshedAt, responsesStateCutoff } from '../../../../repo/responses-retention.ts';
import type { ApiKey, Repo, StoredResponsesItem, StoredResponsesSnapshot } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

interface StatefulResponsesItemLookup {
  readonly apiKeyId: string;
  readonly ids: readonly string[];
  readonly itemHashes: readonly string[];
}

interface StatefulResponsesBacking {
  lookupItems(query: StatefulResponsesItemLookup): Promise<StoredResponsesItem[]>;
  insertItems(items: readonly StoredResponsesItem[]): Promise<void>;
  refreshItems(items: readonly StoredResponsesItem[], refreshedAt: number): Promise<void>;
  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null>;
  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void>;
}

interface LayeredStatefulResponsesStoreOptions {
  readonly apiKeyId: string;
  readonly reads: readonly StatefulResponsesBacking[];
  readonly writes: readonly StatefulResponsesBacking[];
}

type ResponsesSnapshotMode = 'append' | 'replace';

export interface StatefulResponsesStore {
  readonly apiKeyId: string;
  readonly writesState: boolean;
  loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null>;
  loadInputItems(sourceItems: readonly ResponsesInputItem[], inputItemsToStage: readonly ResponsesInputItem[]): Promise<void>;
  getItemById(id: string): StoredResponsesItem | undefined;
  stageInputItems(items: readonly ResponsesInputItem[]): Promise<void>;
  persistOutputItem(row: StoredResponsesItem): Promise<void>;
  commitSnapshot(responseId: string, mode: ResponsesSnapshotMode, outputItemIds: readonly string[]): Promise<void>;
  // Per-attempt transient state. `beginAttempt` reseeds the private-payload
  // scratchpad from hydrated items; interceptors can add server-only state
  // during the turn and output capture persists it with the exact wire item.
  beginAttempt(privatePayloads: ReadonlyMap<string, unknown>): void;
  registerPrivatePayload(id: string, privatePayload: unknown): void;
  getPrivatePayload(id: string): unknown;
}

export class LayeredStatefulResponsesStore implements StatefulResponsesStore {
  private readonly loadedItems = new Map<string, StoredResponsesItem>();
  private readonly loadedByItemHash = new Map<string, StoredResponsesItem>();
  private readonly stagedInputItemIds: string[] = [];
  private previousSnapshotItemIds: string[] = [];
  private readonly committedItemIds = new Set<string>();
  private readonly privatePayloads = new Map<string, unknown>();

  constructor(private readonly options: LayeredStatefulResponsesStoreOptions) {}

  get apiKeyId(): string {
    return this.options.apiKeyId;
  }

  get writesState(): boolean {
    return this.options.writes.length > 0;
  }

  async loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null> {
    for (const backing of this.options.reads) {
      const snapshot = await backing.lookupSnapshot(this.apiKeyId, id);
      if (snapshot === null) continue;
      await this.loadItems({ ids: snapshot.itemIds, itemHashes: [] });
      if (!snapshot.itemIds.every(itemId => this.loadedItems.has(itemId))) continue;
      if (this.options.writes.length > 0) {
        const refreshedAt = quantizeResponsesRefreshedAt(Date.now());
        const items = snapshot.itemIds.map(itemId => this.loadedItems.get(itemId)!);
        await this.commitItems(items);
        const staleItems = items.filter(item => item.refreshedAt < refreshedAt);
        await Promise.all(this.options.writes.map(async write => {
          if (staleItems.length > 0) await write.refreshItems(staleItems, refreshedAt);
          await write.insertSnapshot({ ...snapshot, refreshedAt });
        }));
        for (const item of items) {
          if (item.refreshedAt < refreshedAt) item.refreshedAt = refreshedAt;
        }
        if (snapshot.refreshedAt < refreshedAt) snapshot.refreshedAt = refreshedAt;
      }
      this.previousSnapshotItemIds = [...snapshot.itemIds];
      return cloneStoredResponsesSnapshot(snapshot);
    }
    return null;
  }

  async loadInputItems(
    sourceItems: readonly ResponsesInputItem[],
    inputItemsToStage: readonly ResponsesInputItem[],
  ): Promise<void> {
    const ids = new Set<string>();
    for (const item of sourceItems) {
      const id = responsesItemId(item);
      if (id !== null) ids.add(id);
    }
    const itemHashes = new Set<string>();
    for (const item of this.writesState ? inputItemsToStage : []) {
      if (item.type === 'item_reference' || item.type === 'compaction_trigger') continue;
      if (responsesItemId(item) !== null) continue;
      itemHashes.add(await hashResponsesItem(item));
    }
    await this.loadItems({ ids: [...ids], itemHashes: [...itemHashes] });
  }

  getItemById(id: string): StoredResponsesItem | undefined {
    const row = this.loadedItems.get(id);
    return row === undefined ? undefined : cloneStoredResponsesItem(row);
  }

  async stageInputItems(items: readonly ResponsesInputItem[]): Promise<void> {
    if (!this.writesState) return;
    for (const item of items) await this.stageInputItem(item);
  }

  async persistOutputItem(row: StoredResponsesItem): Promise<void> {
    if (!this.writesState) return;
    const cloned = cloneStoredResponsesItem({
      ...row,
      refreshedAt: quantizeResponsesRefreshedAt(row.refreshedAt),
    });
    await this.commitItems([cloned]);
    this.rememberItem(cloned);
  }

  async commitSnapshot(responseId: string, mode: ResponsesSnapshotMode, outputItemIds: readonly string[]): Promise<void> {
    if (this.options.writes.length === 0) return;
    const itemIds = mode === 'replace'
      ? [...outputItemIds]
      : [...this.previousSnapshotItemIds, ...this.stagedInputItemIds, ...outputItemIds];
    if (itemIds.length === 0) return;
    const uniqueRows = [...new Set(itemIds)].map(id => {
      const row = this.loadedItems.get(id);
      if (row === undefined) throw new Error(`Responses snapshot item disappeared before commit: ${id}`);
      return row;
    });
    await this.commitItems(uniqueRows);
    const refreshedAt = quantizeResponsesRefreshedAt(Date.now());
    const staleRows = uniqueRows.filter(row => row.refreshedAt < refreshedAt);
    if (staleRows.length > 0) {
      await Promise.all(this.options.writes.map(write => write.refreshItems(staleRows, refreshedAt)));
      for (const row of staleRows) {
        if (row.refreshedAt < refreshedAt) row.refreshedAt = refreshedAt;
      }
    }
    const snapshotRefreshedAt = Math.min(...uniqueRows.map(row => row.refreshedAt));
    const snapshot: StoredResponsesSnapshot = {
      id: responseId,
      apiKeyId: this.apiKeyId,
      itemIds,
      refreshedAt: snapshotRefreshedAt,
    };
    await Promise.all(this.options.writes.map(write => write.insertSnapshot(snapshot)));
  }

  beginAttempt(privatePayloads: ReadonlyMap<string, unknown>): void {
    this.privatePayloads.clear();
    for (const [id, payload] of privatePayloads) this.privatePayloads.set(id, structuredClone(payload));
  }

  registerPrivatePayload(id: string, privatePayload: unknown): void {
    if (privatePayload !== undefined) this.privatePayloads.set(id, structuredClone(privatePayload));
  }

  getPrivatePayload(id: string): unknown {
    return structuredClone(this.privatePayloads.get(id));
  }

  private async loadItems(query: { ids: readonly string[]; itemHashes: readonly string[] }): Promise<void> {
    let ids = query.ids.filter(id => !this.loadedItems.has(id));
    for (const backing of this.options.reads) {
      if (ids.length === 0 && query.itemHashes.length === 0) return;
      const results = await backing.lookupItems({ apiKeyId: this.apiKeyId, ids, itemHashes: query.itemHashes });
      for (const item of results) this.rememberItem(item);
      ids = ids.filter(id => !this.loadedItems.has(id));
    }
  }

  private async stageInputItem(item: ResponsesInputItem): Promise<void> {
    if (item.type === 'compaction_trigger') return;
    if (item.type === 'item_reference') {
      const row = this.loadedItems.get(item.id);
      if (row === undefined) throw new Error(`Cannot stage unresolved Responses item_reference id=${item.id}`);
      this.stagedInputItemIds.push(row.id);
      return;
    }

    const id = responsesItemId(item);
    if (id !== null) {
      const row = this.loadedItems.get(id);
      if (row !== undefined) {
        this.stagedInputItemIds.push(row.id);
        return;
      }

      const created: StoredResponsesItem = {
        id,
        apiKeyId: this.apiKeyId,
        payload: { item },
        itemHash: await hashResponsesItem(item),
        refreshedAt: quantizeResponsesRefreshedAt(Date.now()),
      };
      this.stagedInputItemIds.push(id);
      this.rememberItem(created);
      return;
    }

    const itemHash = await hashResponsesItem(item);
    const existing = this.loadedByItemHash.get(itemHash);
    if (existing !== undefined) {
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const row: StoredResponsesItem = {
      id: createResponsesStorageKey(),
      apiKeyId: this.apiKeyId,
      payload: { item },
      itemHash,
      refreshedAt: quantizeResponsesRefreshedAt(Date.now()),
    };
    this.stagedInputItemIds.push(row.id);
    this.rememberItem(row);
  }

  private rememberItem(row: StoredResponsesItem): void {
    const cloned = cloneStoredResponsesItem(row);
    const existing = this.loadedItems.get(cloned.id);
    if (existing !== undefined && existing.refreshedAt >= cloned.refreshedAt) return;
    this.loadedItems.set(cloned.id, cloned);
    const byHash = this.loadedByItemHash.get(cloned.itemHash);
    if (byHash === undefined || compareResponsesItemsByFreshness(cloned, byHash) < 0) {
      this.loadedByItemHash.set(cloned.itemHash, cloned);
    }
  }

  private async commitItems(rows: readonly StoredResponsesItem[]): Promise<void> {
    const pending = rows.flatMap(row => {
      if (!this.committedItemIds.has(row.id)) return [row];
      const committed = this.loadedItems.get(row.id);
      if (committed === undefined) throw new Error(`Committed Responses item disappeared from request state: ${row.id}`);
      assertSameStoredResponsesItem(row, committed);
      return [];
    });
    if (pending.length === 0) return;
    for (const write of this.options.writes) await write.insertItems(pending);
    for (const row of pending) this.committedItemIds.add(row.id);
  }
}

export class RepoStatefulResponsesBacking implements StatefulResponsesBacking {
  private readonly earliestVisibleCutoff: number;

  constructor(
    private readonly getRepo: () => Repo,
    requestStartedAt: number,
    retentionSeconds: number,
  ) {
    this.earliestVisibleCutoff = responsesStateCutoff(requestStartedAt, retentionSeconds);
  }

  async lookupItems(query: StatefulResponsesItemLookup): Promise<StoredResponsesItem[]> {
    const [byId, byItemHash] = await Promise.all([
      this.getRepo().responsesItems.lookupMany(query.apiKeyId, query.ids, this.earliestVisibleCutoff),
      this.getRepo().responsesItems.lookupManyByItemHash(query.apiKeyId, query.itemHashes, this.earliestVisibleCutoff),
    ]);
    const rows = new Map<string, StoredResponsesItem>();
    for (const row of [...byId, ...byItemHash]) rows.set(scopedResponsesKey(row.apiKeyId, row.id), row);
    return [...rows.values()];
  }

  async insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    await this.getRepo().responsesItems.insertMany(items, this.earliestVisibleCutoff);
  }

  async refreshItems(items: readonly StoredResponsesItem[], refreshedAt: number): Promise<void> {
    await this.getRepo().responsesItems.refreshMany(items, refreshedAt, this.earliestVisibleCutoff);
  }

  async lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    return await this.getRepo().responsesSnapshots.lookup(apiKeyId, id, this.earliestVisibleCutoff);
  }

  async insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    await this.getRepo().responsesSnapshots.insert(snapshot);
  }
}

export class MemoryStatefulResponsesBacking implements StatefulResponsesBacking {
  private readonly items = new Map<string, StoredResponsesItem>();
  private readonly snapshots = new Map<string, StoredResponsesSnapshot>();

  lookupItems(query: StatefulResponsesItemLookup): Promise<StoredResponsesItem[]> {
    const ids = new Set(query.ids);
    const hashes = new Set(query.itemHashes);
    return Promise.resolve([...this.items.values()]
      .filter(row => row.apiKeyId === query.apiKeyId && (ids.has(row.id) || hashes.has(row.itemHash)))
      .map(cloneStoredResponsesItem)
      .toSorted(compareResponsesItemsByFreshness));
  }

  async insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    const quantizedItems = items.map(item => ({
      ...item,
      refreshedAt: quantizeResponsesRefreshedAt(item.refreshedAt),
    }));
    const pending = new Map<string, StoredResponsesItem>();
    for (const item of quantizedItems) {
      const key = scopedResponsesKey(item.apiKeyId, item.id);
      const existing = pending.get(key) ?? this.items.get(key);
      if (existing !== undefined) assertSameStoredResponsesItem(item, existing);
      else pending.set(key, item);
    }
    for (const [key, item] of pending) this.items.set(key, cloneStoredResponsesItem(item));
    for (const item of quantizedItems) {
      const stored = this.items.get(scopedResponsesKey(item.apiKeyId, item.id))!;
      if (stored.refreshedAt < item.refreshedAt) stored.refreshedAt = item.refreshedAt;
    }
  }

  async refreshItems(items: readonly StoredResponsesItem[], refreshedAt: number): Promise<void> {
    const quantizedRefreshedAt = quantizeResponsesRefreshedAt(refreshedAt);
    const existing = items.map(item => this.items.get(scopedResponsesKey(item.apiKeyId, item.id)));
    const missingIndex = existing.findIndex(item => item === undefined);
    if (missingIndex !== -1) {
      throw new Error(`Responses item disappeared before retention refresh: ${items[missingIndex].id}`);
    }
    for (let index = 0; index < existing.length; index += 1) {
      assertSameStoredResponsesItem(items[index], existing[index]!);
      if (existing[index]!.refreshedAt < quantizedRefreshedAt) existing[index]!.refreshedAt = quantizedRefreshedAt;
    }
  }

  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.snapshots.get(scopedResponsesKey(apiKeyId, id));
    return Promise.resolve(snapshot === undefined ? null : cloneStoredResponsesSnapshot(snapshot));
  }

  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    const quantized = {
      ...snapshot,
      refreshedAt: quantizeResponsesRefreshedAt(snapshot.refreshedAt),
    };
    const key = scopedResponsesKey(quantized.apiKeyId, quantized.id);
    const existing = this.snapshots.get(key);
    if (existing === undefined || quantized.refreshedAt > existing.refreshedAt) {
      this.snapshots.set(key, cloneStoredResponsesSnapshot(quantized));
    }
    return Promise.resolve();
  }

  // Beyond `StatefulResponsesBacking`: the spec scopes eviction to the
  // connection-local cache, so the delete path deliberately stops at this
  // in-memory backing rather than becoming a contract every backing — the
  // durable one included — has to answer for.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
  evictSnapshot(apiKeyId: string, id: string): void {
    this.snapshots.delete(scopedResponsesKey(apiKeyId, id));
  }
}

type ResponsesStatePolicy = Pick<ApiKey, 'id' | 'responsesRetentionSeconds'>;

const createDurableBacking = (apiKey: ResponsesStatePolicy, requestStartedAt: number): RepoStatefulResponsesBacking | null =>
  apiKey.responsesRetentionSeconds === 0
    ? null
    : new RepoStatefulResponsesBacking(getRepo, requestStartedAt, apiKey.responsesRetentionSeconds);

export const createResponsesHttpStore = (apiKey: ResponsesStatePolicy, requestStartedAt: number, store: boolean | undefined): StatefulResponsesStore => {
  const durable = createDurableBacking(apiKey, requestStartedAt);
  return new LayeredStatefulResponsesStore({
    apiKeyId: apiKey.id,
    reads: durable === null ? [] : [durable],
    writes: durable === null || store === false ? [] : [durable],
  });
};

// Non-Responses sources (Messages / Gemini / Chat Completions) never persist
// Responses items, even when translation enters a Responses attempt — but the
// server-tool shim still runs there, and its request-private payload
// scratchpad lives on the store. So they get a store with no backing: it holds
// per-attempt state in memory and reads/writes nothing durable, keeping the
// store present on every chat ctx.
export const createNonResponsesSourceStore = (apiKeyId: string): StatefulResponsesStore =>
  new LayeredStatefulResponsesStore({ apiKeyId, reads: [], writes: [] });

export const createResponsesWsSession = (): {
  createStore(apiKey: ResponsesStatePolicy, requestStartedAt: number, store: boolean | undefined): StatefulResponsesStore;
  evictSnapshot(apiKeyId: string, id: string): void;
} => {
  // "Servers SHOULD keep the most recent previous-response state in
  // connection-local memory for the active WebSocket. […] With `store=false`,
  // there is no persisted fallback; if the referenced response is not
  // available from connection-local state, the server MUST fail the turn with
  // an error whose code is `previous_response_not_found`."
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L125
  const local = new MemoryStatefulResponsesBacking();
  return {
    createStore(apiKey: ResponsesStatePolicy, requestStartedAt: number, store: boolean | undefined): StatefulResponsesStore {
      const durable = createDurableBacking(apiKey, requestStartedAt);
      // Session-local state is the first store:true collision gate. Writing it
      // first prevents a rejected local history from creating a durable row.
      const writes = store === false || durable === null ? [local] : [local, durable];
      return new LayeredStatefulResponsesStore({
        apiKeyId: apiKey.id,
        reads: durable === null ? [local] : [local, durable],
        writes,
      });
    },
    evictSnapshot(apiKeyId: string, id: string): void {
      local.evictSnapshot(apiKeyId, id);
    },
  };
};
