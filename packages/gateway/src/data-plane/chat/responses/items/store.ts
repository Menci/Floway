import { canonicalResponsesItemType, createResponsesItemId, hashResponsesItemContent, isResponsesItemId, responsesItemId } from './format.ts';
import { getRepo } from '../../../../repo/index.ts';
import { cloneStoredResponsesItem, cloneStoredResponsesSnapshot, compareResponsesItemsByFreshness, scopedResponsesKey } from '../../../../repo/responses-clone.ts';
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
  refreshItems(items: readonly StoredResponsesItem[], createdAt: number): Promise<void>;
  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null>;
  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void>;
}

interface LayeredStatefulResponsesStoreOptions {
  readonly apiKeyId: string;
  readonly reads: readonly StatefulResponsesBacking[];
  readonly writes: readonly StatefulResponsesBacking[];
  readonly stageInputs: boolean;
}

type ResponsesSnapshotMode = 'append' | 'replace';

export interface StatefulResponsesStore {
  readonly apiKeyId: string;
  readonly writesState: boolean;
  loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null>;
  loadInputItems(sourceItems: readonly ResponsesInputItem[], inputItemsToStage: readonly ResponsesInputItem[]): Promise<void>;
  getItemById(id: string): StoredResponsesItem | undefined;
  stageInputItems(items: readonly ResponsesInputItem[]): Promise<void>;
  stageOutputItem(row: StoredResponsesItem, outputIndex: number): void;
  commitStagedOutputItems(): Promise<void>;
  commitSnapshot(responseId: string, mode: ResponsesSnapshotMode): Promise<void>;
}

export class LayeredStatefulResponsesStore implements StatefulResponsesStore {
  private readonly loadedItems = new Map<string, StoredResponsesItem>();
  private readonly loadedByContentHash = new Map<string, StoredResponsesItem[]>();
  private readonly stagedInputItemIds: string[] = [];
  private readonly stagedOutputItems = new Map<string, StoredResponsesItem>();
  private readonly stagedOutputItemIds = new Map<number, string>();
  private previousSnapshotItemIds: string[] = [];
  private readonly committedItemIds = new Set<string>();
  private readonly freshItemIds = new Set<string>();

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

  async loadInputItems(sourceItems: readonly ResponsesInputItem[], inputItemsToStage: readonly ResponsesInputItem[]): Promise<void> {
    const ids = new Set<string>();
    for (const item of sourceItems) {
      const id = responsesItemId(item);
      if (id !== null && isResponsesItemId(id)) ids.add(id);
    }
    const contentHashes = new Set<string>();
    for (const item of inputItemsToStage) {
      const id = responsesItemId(item);
      if (id !== null && isResponsesItemId(id)) continue;
      contentHashes.add(await hashResponsesItemContent(item));
    }
    await this.loadItems({ ids: [...ids], contentHashes: [...contentHashes] });
  }

  getItemById(id: string): StoredResponsesItem | undefined {
    const row = this.loadedItems.get(id);
    return row === undefined ? undefined : cloneStoredResponsesItem(row);
  }

  async stageInputItems(items: readonly ResponsesInputItem[]): Promise<void> {
    if (!this.options.stageInputs) return;
    for (const item of items) await this.stageInputItem(item);
  }

  stageOutputItem(row: StoredResponsesItem, outputIndex: number): void {
    const cloned = cloneStoredResponsesItem(row);
    this.stagedOutputItems.set(cloned.id, cloned);
    this.stagedOutputItemIds.set(outputIndex, cloned.id);
    this.freshItemIds.add(cloned.id);
    this.rememberItem(cloned);
  }

  async commitStagedOutputItems(): Promise<void> {
    await this.commitItems([...this.stagedOutputItems.values()]);
  }

  async commitSnapshot(responseId: string, mode: ResponsesSnapshotMode): Promise<void> {
    if (this.options.writes.length === 0) return;
    const outputItemIds = [...this.stagedOutputItemIds.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([, id]) => id);
    const itemIds = mode === 'replace'
      ? outputItemIds
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
      const row = this.getItemById(item.id);
      if (row === undefined) throw new Error(`Cannot stage unresolved Responses item_reference id=${item.id}`);
      this.stagedInputItemIds.push(row.id);
      return;
    }

    const id = responsesItemId(item);
    if (id !== null && isResponsesItemId(id)) {
      const row = this.getItemById(id);
      if (row !== undefined) {
        this.stagedInputItemIds.push(row.id);
        return;
      }
    }

    const contentHash = await hashResponsesItemContent(item);
    const existing = this.loadedByContentHash.get(contentHash)?.[0];
    if (existing !== undefined) {
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const row: StoredResponsesItem = {
      id: createResponsesItemId(item.type),
      apiKeyId: this.apiKeyId,
      itemType: canonicalResponsesItemType(item.type),
      payload: { item: structuredClone(item) },
      contentHash,
      createdAt: Date.now(),
    };
    this.stagedInputItemIds.push(row.id);
    this.freshItemIds.add(row.id);
    this.rememberItem(row);
  }

  private rememberItem(row: StoredResponsesItem): void {
    const cloned = cloneStoredResponsesItem(row);
    this.loadedItems.set(cloned.id, cloned);
    if (cloned.contentHash !== null) {
      const byHash = this.loadedByContentHash.get(cloned.contentHash) ?? [];
      if (!byHash.some(existing => existing.id === cloned.id)) {
        byHash.push(cloned);
        byHash.sort(compareResponsesItemsByFreshness);
        this.loadedByContentHash.set(cloned.contentHash, byHash);
      }
    }
  }

  private async commitItems(rows: readonly StoredResponsesItem[]): Promise<void> {
    const pending = rows.filter(row => !this.committedItemIds.has(row.id));
    if (pending.length === 0) return;
    await Promise.all(this.options.writes.map(async write => await write.insertItems(pending)));
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

  async refreshItems(items: readonly StoredResponsesItem[], createdAt: number): Promise<void> {
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
      .filter(row => row.apiKeyId === query.apiKeyId && (ids.has(row.id) || (row.contentHash !== null && hashes.has(row.contentHash))))
      .map(cloneStoredResponsesItem)
      .toSorted(compareResponsesItemsByFreshness));
  }

  insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    for (const item of items) {
      const key = scopedResponsesKey(item.apiKeyId, item.id);
      if (this.items.has(key)) continue;
      this.items.set(key, cloneStoredResponsesItem(item));
    }
    return Promise.resolve();
  }

  refreshItems(items: readonly StoredResponsesItem[], createdAt: number): Promise<void> {
    const existing = items.map(item => this.items.get(scopedResponsesKey(item.apiKeyId, item.id)));
    const missingIndex = existing.findIndex(item => item === undefined);
    if (missingIndex !== -1) {
      return Promise.reject(new Error(`Responses item disappeared before lifetime refresh: ${items[missingIndex].id}`));
    }
    for (const item of existing) item!.createdAt = Math.max(item!.createdAt, createdAt);
    return Promise.resolve();
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
    stageInputs: store !== false,
  });
};

export const createResponsesWsSession = (): {
  createStore(apiKeyId: string, store: boolean | undefined): StatefulResponsesStore;
} => {
  const local = new MemoryStatefulResponsesBacking();
  const durable = new RepoStatefulResponsesBacking(getRepo);
  return {
    createStore(apiKeyId: string, store: boolean | undefined): StatefulResponsesStore {
      const writes = store === false ? [local] : [local, durable];
      return new LayeredStatefulResponsesStore({
        apiKeyId,
        reads: [local, durable],
        writes,
        stageInputs: true,
      });
    },
  };
};
