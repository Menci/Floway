import { createResponsesStorageKey, hashResponsesItemContent, responsesItemId } from './identity.ts';
import { getRepo } from '../../../../repo/index.ts';
import { assertSameStoredResponsesItem, cloneStoredResponsesItem, cloneStoredResponsesSnapshot, compareResponsesItemsByFreshness, scopedResponsesKey } from '../../../../repo/responses-clone.ts';
import type { Repo, StoredResponsesItem, StoredResponsesSnapshot } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

interface StatefulResponsesItemLookup {
  readonly apiKeyId: string;
  readonly ids: readonly string[];
  readonly contentHashes: readonly string[];
}

interface StatefulResponsesBacking {
  lookupItems(query: StatefulResponsesItemLookup): Promise<StoredResponsesItem[]>;
  insertItems(items: readonly StoredResponsesItem[]): Promise<void>;
  refreshItems(items: readonly Pick<StoredResponsesItem, 'id' | 'apiKeyId'>[], createdAt: number): Promise<void>;
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
  private readonly loadedByContentHash = new Map<string, StoredResponsesItem>();
  private readonly stagedInputItemIds: string[] = [];
  private previousSnapshotItemIds: string[] = [];
  private readonly committedItemIds = new Set<string>();
  private readonly freshItemIds = new Set<string>();
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
      await this.loadItems({ ids: snapshot.itemIds, contentHashes: [] });
      if (!snapshot.itemIds.every(itemId => this.loadedItems.has(itemId))) continue;
      if (this.options.writes.length > 0) {
        const createdAt = Date.now();
        const items = snapshot.itemIds.map(itemId => this.loadedItems.get(itemId)!);
        await this.commitItems(items);
        await Promise.all(this.options.writes.map(async write => {
          await write.refreshItems(items, createdAt);
          await write.insertSnapshot({ ...snapshot, createdAt });
        }));
        for (const item of items) {
          item.createdAt = Math.max(item.createdAt, createdAt);
          this.freshItemIds.add(item.id);
        }
        snapshot.createdAt = Math.max(snapshot.createdAt, createdAt);
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
    const contentHashes = new Set<string>();
    for (const item of this.writesState ? inputItemsToStage : []) {
      if (item.type === 'item_reference' || item.type === 'compaction_trigger') continue;
      if (responsesItemId(item) !== null) continue;
      contentHashes.add(await hashResponsesItemContent(item));
    }
    await this.loadItems({ ids: [...ids], contentHashes: [...contentHashes] });
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
    const cloned = cloneStoredResponsesItem(row);
    await this.commitItems([cloned]);
    this.freshItemIds.add(cloned.id);
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
    const staleRows = uniqueRows.filter(row => !this.freshItemIds.has(row.id));
    if (staleRows.length > 0) {
      const createdAt = Date.now();
      await Promise.all(this.options.writes.map(write => write.refreshItems(staleRows, createdAt)));
      for (const row of staleRows) {
        row.createdAt = Math.max(row.createdAt, createdAt);
        this.freshItemIds.add(row.id);
      }
    }
    const snapshotCreatedAt = Math.min(...uniqueRows.map(row => row.createdAt));
    const snapshot: StoredResponsesSnapshot = {
      id: responseId,
      apiKeyId: this.apiKeyId,
      itemIds,
      createdAt: snapshotCreatedAt,
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

  private async loadItems(query: { ids: readonly string[]; contentHashes: readonly string[] }): Promise<void> {
    let ids = query.ids.filter(id => !this.loadedItems.has(id));
    for (const backing of this.options.reads) {
      if (ids.length === 0 && query.contentHashes.length === 0) return;
      const results = await backing.lookupItems({ apiKeyId: this.apiKeyId, ids, contentHashes: query.contentHashes });
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
        contentHash: await hashResponsesItemContent(item),
        createdAt: Date.now(),
      };
      this.stagedInputItemIds.push(id);
      this.freshItemIds.add(id);
      this.rememberItem(created);
      return;
    }

    const contentHash = await hashResponsesItemContent(item);
    const existing = this.loadedByContentHash.get(contentHash);
    if (existing !== undefined) {
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const row: StoredResponsesItem = {
      id: createResponsesStorageKey(),
      apiKeyId: this.apiKeyId,
      payload: { item },
      contentHash,
      createdAt: Date.now(),
    };
    this.stagedInputItemIds.push(row.id);
    this.freshItemIds.add(row.id);
    this.rememberItem(row);
  }

  private rememberItem(row: StoredResponsesItem): void {
    const cloned = cloneStoredResponsesItem(row);
    const existing = this.loadedItems.get(cloned.id);
    if (existing !== undefined && existing.createdAt >= cloned.createdAt) return;
    this.loadedItems.set(cloned.id, cloned);
    const byHash = this.loadedByContentHash.get(cloned.contentHash);
    if (byHash === undefined || compareResponsesItemsByFreshness(cloned, byHash) < 0) {
      this.loadedByContentHash.set(cloned.contentHash, cloned);
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
  constructor(private readonly getRepo: () => Repo) {}

  async lookupItems(query: StatefulResponsesItemLookup): Promise<StoredResponsesItem[]> {
    const [byId, byContentHash] = await Promise.all([
      this.getRepo().responsesItems.lookupMany(query.apiKeyId, query.ids),
      this.getRepo().responsesItems.lookupManyByContentHash(query.apiKeyId, query.contentHashes),
    ]);
    const rows = new Map<string, StoredResponsesItem>();
    for (const row of [...byId, ...byContentHash]) rows.set(scopedResponsesKey(row.apiKeyId, row.id), row);
    return [...rows.values()];
  }

  async insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    await this.getRepo().responsesItems.insertMany(items);
  }

  async refreshItems(items: readonly Pick<StoredResponsesItem, 'id' | 'apiKeyId'>[], createdAt: number): Promise<void> {
    await this.getRepo().responsesItems.refreshMany(items, createdAt);
  }

  async lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    return await this.getRepo().responsesSnapshots.lookup(apiKeyId, id);
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
    const hashes = new Set(query.contentHashes);
    return Promise.resolve([...this.items.values()]
      .filter(row => row.apiKeyId === query.apiKeyId && (ids.has(row.id) || hashes.has(row.contentHash)))
      .map(cloneStoredResponsesItem)
      .toSorted(compareResponsesItemsByFreshness));
  }

  async insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    const pending = new Map<string, StoredResponsesItem>();
    for (const item of items) {
      const key = scopedResponsesKey(item.apiKeyId, item.id);
      const existing = pending.get(key) ?? this.items.get(key);
      if (existing !== undefined) assertSameStoredResponsesItem(item, existing);
      else pending.set(key, item);
    }
    for (const [key, item] of pending) this.items.set(key, cloneStoredResponsesItem(item));
    for (const item of items) {
      const stored = this.items.get(scopedResponsesKey(item.apiKeyId, item.id))!;
      stored.createdAt = Math.max(stored.createdAt, item.createdAt);
    }
  }

  async refreshItems(items: readonly Pick<StoredResponsesItem, 'id' | 'apiKeyId'>[], createdAt: number): Promise<void> {
    const existing = items.map(item => this.items.get(scopedResponsesKey(item.apiKeyId, item.id)));
    const missingIndex = existing.findIndex(item => item === undefined);
    if (missingIndex !== -1) {
      throw new Error(`Responses item disappeared before lifetime refresh: ${items[missingIndex].id}`);
    }
    for (const item of existing) item!.createdAt = Math.max(item!.createdAt, createdAt);
  }

  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.snapshots.get(scopedResponsesKey(apiKeyId, id));
    return Promise.resolve(snapshot === undefined ? null : cloneStoredResponsesSnapshot(snapshot));
  }

  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    const key = scopedResponsesKey(snapshot.apiKeyId, snapshot.id);
    const existing = this.snapshots.get(key);
    if (existing === undefined || snapshot.createdAt >= existing.createdAt) {
      this.snapshots.set(key, cloneStoredResponsesSnapshot(snapshot));
    }
    return Promise.resolve();
  }
}

export const createResponsesHttpStore = (apiKeyId: string, store: boolean | undefined): StatefulResponsesStore => {
  const backing = new RepoStatefulResponsesBacking(getRepo);
  const writes = store === false ? [] : [backing];
  return new LayeredStatefulResponsesStore({
    apiKeyId,
    reads: [backing],
    writes,
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
  createStore(apiKeyId: string, store: boolean | undefined): StatefulResponsesStore;
} => {
  const local = new MemoryStatefulResponsesBacking();
  const durable = new RepoStatefulResponsesBacking(getRepo);
  return {
    createStore(apiKeyId: string, store: boolean | undefined): StatefulResponsesStore {
      // Session-local state is the first store:true collision gate. Writing it
      // first prevents a rejected local history from creating a durable row.
      const writes = store === false ? [local] : [local, durable];
      return new LayeredStatefulResponsesStore({
        apiKeyId,
        reads: [local, durable],
        writes,
      });
    },
  };
};
