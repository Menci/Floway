import { createStoredResponsesItemId, hashResponsesItemContent, isStoredResponsesItemId, responsesItemId } from './format.ts';
import { getRepo } from '../../../../repo/index.ts';
import { cloneStoredResponsesItem, cloneStoredResponsesSnapshot, compareResponsesItemsByFreshness, scopedResponsesKey } from '../../../../repo/responses-clone.ts';
import type { Repo, StoredResponsesItem, StoredResponsesSnapshot } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';

export interface StatefulResponsesItemLookup {
  readonly apiKeyId: string;
  readonly ids: readonly string[];
  readonly contentHashes: readonly string[];
}

export interface StatefulResponsesItemLookupResult {
  readonly item: StoredResponsesItem;
  readonly durable: boolean;
}

export interface StatefulResponsesBacking {
  lookupItems(query: StatefulResponsesItemLookup): Promise<StatefulResponsesItemLookupResult[]>;
  insertItems(items: readonly StoredResponsesItem[], options: { readonly durable: boolean }): Promise<void>;
  markDurable?(apiKeyId: string, id: string): void;
  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null>;
  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void>;
}

export interface StatefulResponsesWriteTarget {
  readonly backing: StatefulResponsesBacking;
  readonly durable: boolean;
}

export interface LayeredStatefulResponsesStoreOptions {
  readonly apiKeyId: string;
  readonly reads: readonly StatefulResponsesBacking[];
  readonly writes: readonly StatefulResponsesWriteTarget[];
  readonly stageInputs: boolean;
}

export type ResponsesSnapshotMode = 'append' | 'replace';

export interface StatefulResponsesStore {
  readonly apiKeyId: string;
  loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null>;
  loadInputItems(sourceItems: readonly ResponsesInputItem[], inputItemsToStage: readonly ResponsesInputItem[]): Promise<void>;
  getItemById(id: string): StoredResponsesItem | undefined;
  hashItemContent(item: ResponsesInputItem): Promise<string>;
  stageInputItems(items: readonly ResponsesInputItem[]): Promise<void>;
  stageOutputItem(row: StoredResponsesItem): void;
  commitOutputItems(): Promise<void>;
  commitSnapshot(responseId: string, mode: ResponsesSnapshotMode): Promise<void>;
}

export class LayeredStatefulResponsesStore implements StatefulResponsesStore {
  private readonly loadedItems = new Map<string, StoredResponsesItem>();
  private readonly loadedByContentHash = new Map<string, StoredResponsesItem[]>();
  private readonly stagedInputItems = new Map<string, StoredResponsesItem>();
  private readonly stagedInputItemIds: string[] = [];
  private readonly stagedOutputItems = new Map<string, StoredResponsesItem>();
  private readonly stagedOutputItemIds: string[] = [];
  private previousSnapshotItemIds: string[] = [];
  private readonly committedItemIds = new Set<string>();
  private readonly durableItemIds = new Set<string>();

  constructor(private readonly options: LayeredStatefulResponsesStoreOptions) {}

  get apiKeyId(): string {
    return this.options.apiKeyId;
  }

  hashItemContent(item: ResponsesInputItem): Promise<string> {
    return hashResponsesItemContent(item);
  }

  async loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null> {
    for (const backing of this.options.reads) {
      const snapshot = await backing.lookupSnapshot(this.apiKeyId, id);
      if (snapshot === null) continue;
      await this.loadItems({ ids: snapshot.itemIds, contentHashes: [] });
      if (!snapshot.itemIds.every(itemId => this.loadedItems.has(itemId))) continue;
      this.previousSnapshotItemIds = [...snapshot.itemIds];
      return cloneStoredResponsesSnapshot(snapshot);
    }
    return null;
  }

  async loadInputItems(sourceItems: readonly ResponsesInputItem[], inputItemsToStage: readonly ResponsesInputItem[]): Promise<void> {
    const ids = new Set<string>();
    for (const item of sourceItems) {
      const id = responsesItemId(item);
      if (id !== null && isStoredResponsesItemId(id)) ids.add(id);
    }
    const contentHashes = new Set<string>();
    for (const item of inputItemsToStage) {
      const id = responsesItemId(item);
      if (id !== null && isStoredResponsesItemId(id)) continue;
      contentHashes.add(await this.hashItemContent(item));
    }
    await this.loadItems({ ids: [...ids], contentHashes: [...contentHashes] });
  }

  getItemById(id: string): StoredResponsesItem | undefined {
    const row = this.loadedItems.get(id) ?? this.stagedInputItems.get(id) ?? this.stagedOutputItems.get(id);
    return row === undefined ? undefined : cloneStoredResponsesItem(row);
  }

  async stageInputItems(items: readonly ResponsesInputItem[]): Promise<void> {
    if (!this.options.stageInputs) return;
    for (const item of items) await this.stageInputItem(item);
  }

  stageOutputItem(row: StoredResponsesItem): void {
    const cloned = cloneStoredResponsesItem(row);
    this.stagedOutputItems.set(cloned.id, cloned);
    this.stagedOutputItemIds.push(cloned.id);
    this.rememberItem(cloned);
  }

  async commitOutputItems(): Promise<void> {
    await this.commitItems([...this.stagedOutputItems.values()]);
  }

  async commitSnapshot(responseId: string, mode: ResponsesSnapshotMode): Promise<void> {
    if (this.options.writes.length === 0) return;
    const previousItems = this.previousSnapshotItemIds.map(id => {
      const item = this.loadedItems.get(id);
      if (item === undefined) throw new Error(`Responses snapshot item disappeared before commit: ${id}`);
      return item;
    });
    await this.commitItems([...previousItems, ...this.stagedInputItems.values(), ...this.stagedOutputItems.values()]);
    const itemIds = mode === 'replace'
      ? [...this.stagedOutputItemIds]
      : [...this.previousSnapshotItemIds, ...this.stagedInputItemIds, ...this.stagedOutputItemIds];
    if (itemIds.length === 0) return;
    const snapshot: StoredResponsesSnapshot = {
      id: responseId,
      apiKeyId: this.apiKeyId,
      itemIds,
      createdAt: Date.now(),
    };
    await Promise.all(this.options.writes.map(write => write.backing.insertSnapshot(snapshot)));
  }

  private async loadItems(query: { ids: readonly string[]; contentHashes: readonly string[] }): Promise<void> {
    let ids = query.ids.filter(id => !this.loadedItems.has(id));
    for (const backing of this.options.reads) {
      if (ids.length === 0 && query.contentHashes.length === 0) return;
      const results = await backing.lookupItems({ apiKeyId: this.apiKeyId, ids, contentHashes: query.contentHashes });
      for (const result of results) this.rememberItem(result.item, result.durable);
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
    if (id !== null && isStoredResponsesItemId(id)) {
      const row = this.getItemById(id);
      if (row !== undefined) {
        this.stagedInputItemIds.push(row.id);
        return;
      }
    }

    const contentHash = await this.hashItemContent(item);
    const existing = this.loadedByContentHash.get(contentHash)?.[0];
    if (existing !== undefined) {
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const row: StoredResponsesItem = {
      id: createStoredResponsesItemId(item.type),
      apiKeyId: this.apiKeyId,
      itemType: item.type,
      payload: { item: structuredClone(item) },
      contentHash,
      createdAt: Date.now(),
    };
    this.stagedInputItems.set(row.id, row);
    this.stagedInputItemIds.push(row.id);
    this.rememberItem(row);
  }

  private rememberItem(row: StoredResponsesItem, durable = false): void {
    const cloned = cloneStoredResponsesItem(row);
    this.loadedItems.set(cloned.id, cloned);
    if (durable) this.durableItemIds.add(cloned.id);
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
    await Promise.all(this.options.writes.map(async write => {
      const writable = write.durable ? pending.filter(row => !this.durableItemIds.has(row.id)) : pending;
      if (writable.length === 0) return;
      await write.backing.insertItems(writable, { durable: write.durable });
      if (!write.durable) return;
      for (const row of writable) {
        this.durableItemIds.add(row.id);
        for (const target of this.options.writes) {
          if (!target.durable) target.backing.markDurable?.(row.apiKeyId, row.id);
        }
      }
    }));
    for (const row of pending) this.committedItemIds.add(row.id);
  }
}

export class RepoStatefulResponsesBacking implements StatefulResponsesBacking {
  constructor(private readonly getRepo: () => Repo) {}

  async lookupItems(query: StatefulResponsesItemLookup): Promise<StatefulResponsesItemLookupResult[]> {
    const [byId, byContentHash] = await Promise.all([
      this.getRepo().responsesItems.lookupMany(query.apiKeyId, query.ids),
      this.getRepo().responsesItems.lookupManyByContentHash(query.apiKeyId, query.contentHashes),
    ]);
    const rows = new Map<string, StoredResponsesItem>();
    for (const row of [...byId, ...byContentHash]) rows.set(scopedResponsesKey(row.apiKeyId, row.id), row);
    return [...rows.values()].map(item => ({ item, durable: true }));
  }

  async insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    await this.getRepo().responsesItems.insertMany(items);
  }

  async lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    return await this.getRepo().responsesSnapshots.lookup(apiKeyId, id);
  }

  async insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    await this.getRepo().responsesSnapshots.insert(snapshot);
  }
}

export class MemoryStatefulResponsesBacking implements StatefulResponsesBacking {
  private readonly items = new Map<string, { row: StoredResponsesItem; durable: boolean }>();
  private readonly snapshots = new Map<string, StoredResponsesSnapshot>();

  lookupItems(query: StatefulResponsesItemLookup): Promise<StatefulResponsesItemLookupResult[]> {
    const ids = new Set(query.ids);
    const hashes = new Set(query.contentHashes);
    return Promise.resolve([...this.items.values()]
      .filter(({ row }) => row.apiKeyId === query.apiKeyId && (ids.has(row.id) || (row.contentHash !== null && hashes.has(row.contentHash))))
      .map(({ row, durable }) => ({ item: cloneStoredResponsesItem(row), durable }))
      .toSorted((a, b) => compareResponsesItemsByFreshness(a.item, b.item)));
  }

  insertItems(items: readonly StoredResponsesItem[], options: { readonly durable: boolean }): Promise<void> {
    for (const item of items) {
      const key = scopedResponsesKey(item.apiKeyId, item.id);
      const existing = this.items.get(key);
      if (existing !== undefined) {
        if (options.durable) existing.durable = true;
        continue;
      }
      this.items.set(key, { row: cloneStoredResponsesItem(item), durable: options.durable });
    }
    return Promise.resolve();
  }

  markDurable(apiKeyId: string, id: string): void {
    const existing = this.items.get(scopedResponsesKey(apiKeyId, id));
    if (existing !== undefined) existing.durable = true;
  }

  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.snapshots.get(scopedResponsesKey(apiKeyId, id));
    return Promise.resolve(snapshot === undefined ? null : cloneStoredResponsesSnapshot(snapshot));
  }

  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    this.snapshots.set(scopedResponsesKey(snapshot.apiKeyId, snapshot.id), cloneStoredResponsesSnapshot(snapshot));
    return Promise.resolve();
  }
}

export const createResponsesHttpStore = (apiKeyId: string, store: boolean | undefined): StatefulResponsesStore => {
  const backing = new RepoStatefulResponsesBacking(getRepo);
  const writes = store === false ? [] : [{ backing, durable: true }];
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
      const localWrite = { backing: local, durable: false };
      const writes = store === false ? [localWrite] : [localWrite, { backing: durable, durable: true }];
      return new LayeredStatefulResponsesStore({
        apiKeyId,
        reads: [local, durable],
        writes,
        stageInputs: true,
      });
    },
  };
};
