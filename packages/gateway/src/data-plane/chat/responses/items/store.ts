import { createResponsesStorageKey, hashResponsesItemContent, responsesItemId } from './identity.ts';
import { getRepo } from '../../../../repo/index.ts';
import { assertSameStoredResponsesItem, cloneStoredResponsesItem, cloneStoredResponsesSnapshot, compareResponsesItemsByFreshness, scopedResponsesKey } from '../../../../repo/responses-clone.ts';
import { responsesStateLifetime } from '../../../../repo/responses-retention.ts';
import type { ApiKey, Repo, StoredResponsesItem, StoredResponsesSnapshot } from '../../../../repo/types.ts';
import type { ResponsesInputItem, ResponsesOutputItem } from '@floway-dev/protocols/responses';

interface StatefulResponsesItemLookup {
  readonly apiKeyId: string;
  readonly stateEpoch: string;
  readonly activeAt: number;
  readonly ids: readonly string[];
  readonly contentHashes: readonly string[];
}

interface StatefulResponsesBacking {
  lookupItems(query: StatefulResponsesItemLookup): Promise<StoredResponsesItem[]>;
  insertItems(items: readonly StoredResponsesItem[]): Promise<void>;
  lookupSnapshot(query: Pick<StatefulResponsesItemLookup, 'apiKeyId' | 'stateEpoch' | 'activeAt'>, id: string): Promise<StoredResponsesSnapshot | null>;
  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void>;
}

interface LayeredStatefulResponsesStoreOptions {
  readonly apiKeyId: string;
  readonly stateEpoch: string;
  readonly retentionSeconds: number | null;
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
  persistOutputItem(item: ResponsesOutputItem): Promise<string>;
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
  private readonly privatePayloads = new Map<string, unknown>();
  private readonly activeAt = Date.now();

  constructor(private readonly options: LayeredStatefulResponsesStoreOptions) {}

  get apiKeyId(): string {
    return this.options.apiKeyId;
  }

  get writesState(): boolean {
    return this.options.writes.length > 0;
  }

  async loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null> {
    for (const backing of this.options.reads) {
      const snapshot = await backing.lookupSnapshot({
        apiKeyId: this.apiKeyId,
        stateEpoch: this.options.stateEpoch,
        activeAt: this.activeAt,
      }, id);
      if (snapshot === null) continue;
      await this.loadItems({ ids: snapshot.itemIds, contentHashes: [] });
      if (!snapshot.itemIds.every(itemId => this.loadedItems.has(itemId))) continue;
      if (this.options.writes.length > 0) {
        const items = snapshot.itemIds.map(itemId => this.loadedItems.get(itemId)!);
        await this.commitItems(items);
        const lifetime = this.lifetime(Date.now());
        const refreshedSnapshot = { ...snapshot, stateEpoch: this.options.stateEpoch, ...lifetime };
        await Promise.all(this.options.writes.map(async write => await write.insertSnapshot(refreshedSnapshot)));
        Object.assign(snapshot, refreshedSnapshot);
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

  async persistOutputItem(item: ResponsesOutputItem): Promise<string> {
    const id = responsesItemId(item);
    if (id === null) throw new TypeError(`Responses ${item.type} output has no producer id`);
    if (!this.writesState) return id;
    const privatePayload = this.getPrivatePayload(id);
    const payload: StoredResponsesItem['payload'] = {
      item,
      ...(privatePayload !== undefined ? { private: privatePayload } : {}),
    };
    const row: StoredResponsesItem = {
      id,
      apiKeyId: this.apiKeyId,
      stateEpoch: this.options.stateEpoch,
      payload,
      contentHash: await hashResponsesItemContent(item),
      payloadHash: await hashResponsesItemContent(payload),
      ...this.lifetime(Date.now()),
    };
    await this.commitItems([row]);
    this.rememberItem(row);
    return id;
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
    const snapshotRefreshedAt = Math.min(...uniqueRows.map(row => row.refreshedAt));
    const snapshotExpiresAt = Math.min(...uniqueRows.map(row => row.expiresAt));
    const snapshot: StoredResponsesSnapshot = {
      id: responseId,
      apiKeyId: this.apiKeyId,
      stateEpoch: this.options.stateEpoch,
      itemIds,
      refreshedAt: snapshotRefreshedAt,
      expiresAt: snapshotExpiresAt,
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
      const results = await backing.lookupItems({
        apiKeyId: this.apiKeyId,
        stateEpoch: this.options.stateEpoch,
        activeAt: this.activeAt,
        ids,
        contentHashes: query.contentHashes,
      });
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

      const payload: StoredResponsesItem['payload'] = { item };
      const created: StoredResponsesItem = {
        id,
        apiKeyId: this.apiKeyId,
        stateEpoch: this.options.stateEpoch,
        payload,
        contentHash: await hashResponsesItemContent(item),
        payloadHash: await hashResponsesItemContent(payload),
        ...this.lifetime(Date.now()),
      };
      this.stagedInputItemIds.push(id);
      this.rememberItem(created);
      return;
    }

    const contentHash = await hashResponsesItemContent(item);
    const existing = this.loadedByContentHash.get(contentHash);
    if (existing !== undefined) {
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const payload: StoredResponsesItem['payload'] = { item };
    const row: StoredResponsesItem = {
      id: createResponsesStorageKey(),
      apiKeyId: this.apiKeyId,
      stateEpoch: this.options.stateEpoch,
      payload,
      contentHash,
      payloadHash: await hashResponsesItemContent(payload),
      ...this.lifetime(Date.now()),
    };
    this.stagedInputItemIds.push(row.id);
    this.rememberItem(row);
  }

  private rememberItem(row: StoredResponsesItem): void {
    const cloned = cloneStoredResponsesItem(row);
    const existing = this.loadedItems.get(cloned.id);
    if (existing !== undefined && existing.refreshedAt >= cloned.refreshedAt) return;
    this.loadedItems.set(cloned.id, cloned);
    const byHash = this.loadedByContentHash.get(cloned.contentHash);
    if (byHash === undefined || compareResponsesItemsByFreshness(cloned, byHash) < 0) {
      this.loadedByContentHash.set(cloned.contentHash, cloned);
    }
  }

  private async commitItems(rows: readonly StoredResponsesItem[]): Promise<void> {
    const lifetime = this.lifetime(Date.now());
    const currentRows = rows.map(row => ({
      ...row,
      stateEpoch: this.options.stateEpoch,
      ...lifetime,
    }));
    const pending = currentRows.flatMap(row => {
      if (!this.committedItemIds.has(row.id)) return [row];
      const committed = this.loadedItems.get(row.id);
      if (committed === undefined) throw new Error(`Committed Responses item disappeared from request state: ${row.id}`);
      assertSameStoredResponsesItem(row, committed);
      return [];
    });
    if (pending.length === 0) return;
    for (const write of this.options.writes) await write.insertItems(pending);
    for (const row of pending) {
      this.committedItemIds.add(row.id);
      this.rememberItem(row);
    }
  }

  private lifetime(refreshedAt: number): Pick<StoredResponsesItem, 'refreshedAt' | 'expiresAt'> {
    return this.options.retentionSeconds === null
      ? { refreshedAt, expiresAt: Number.MAX_SAFE_INTEGER }
      : responsesStateLifetime(refreshedAt, this.options.retentionSeconds);
  }
}

export class RepoStatefulResponsesBacking implements StatefulResponsesBacking {
  constructor(private readonly getRepo: () => Repo) {}

  async lookupItems(query: StatefulResponsesItemLookup): Promise<StoredResponsesItem[]> {
    const [byId, byContentHash] = await Promise.all([
      this.getRepo().responsesItems.lookupActiveMany(query.apiKeyId, query.stateEpoch, query.ids, query.activeAt),
      this.getRepo().responsesItems.lookupActiveManyByContentHash(query.apiKeyId, query.stateEpoch, query.contentHashes, query.activeAt),
    ]);
    const rows = new Map<string, StoredResponsesItem>();
    for (const row of [...byId, ...byContentHash]) rows.set(scopedResponsesKey(row.apiKeyId, row.id), row);
    return [...rows.values()];
  }

  async insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    await this.getRepo().responsesItems.insertMany(items, Date.now());
  }

  async lookupSnapshot(query: Pick<StatefulResponsesItemLookup, 'apiKeyId' | 'stateEpoch' | 'activeAt'>, id: string): Promise<StoredResponsesSnapshot | null> {
    return await this.getRepo().responsesSnapshots.lookupActive(query.apiKeyId, query.stateEpoch, id, query.activeAt);
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
      if (item.refreshedAt >= stored.refreshedAt) {
        stored.refreshedAt = item.refreshedAt;
        stored.expiresAt = item.expiresAt;
      }
    }
  }

  lookupSnapshot(query: Pick<StatefulResponsesItemLookup, 'apiKeyId'>, id: string): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.snapshots.get(scopedResponsesKey(query.apiKeyId, id));
    return Promise.resolve(snapshot === undefined ? null : cloneStoredResponsesSnapshot(snapshot));
  }

  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    const key = scopedResponsesKey(snapshot.apiKeyId, snapshot.id);
    const existing = this.snapshots.get(key);
    if (existing === undefined || snapshot.refreshedAt >= existing.refreshedAt) {
      this.snapshots.set(key, cloneStoredResponsesSnapshot(snapshot));
    }
    return Promise.resolve();
  }
}

export interface ResponsesStatePolicy {
  readonly apiKeyId: string;
  readonly stateEpoch: string;
  readonly retentionSeconds: number;
}

export const responsesStatePolicyFromApiKey = (
  apiKey: Pick<ApiKey, 'id' | 'responsesStateEpoch' | 'responsesRetentionSeconds'>,
): ResponsesStatePolicy => ({
  apiKeyId: apiKey.id,
  stateEpoch: apiKey.responsesStateEpoch,
  retentionSeconds: apiKey.responsesRetentionSeconds,
});

export const createResponsesHttpStore = (policy: ResponsesStatePolicy, store: boolean | undefined): StatefulResponsesStore => {
  const backing = policy.retentionSeconds === 0 ? null : new RepoStatefulResponsesBacking(getRepo);
  const reads = backing === null ? [] : [backing];
  const writes = backing === null || store === false ? [] : [backing];
  return new LayeredStatefulResponsesStore({
    apiKeyId: policy.apiKeyId,
    stateEpoch: policy.stateEpoch,
    retentionSeconds: policy.retentionSeconds === 0 ? null : policy.retentionSeconds,
    reads,
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
  new LayeredStatefulResponsesStore({ apiKeyId, stateEpoch: '', retentionSeconds: null, reads: [], writes: [] });

export const createResponsesWsSession = (): {
  createStore(policy: ResponsesStatePolicy, store: boolean | undefined): StatefulResponsesStore;
} => {
  const local = new MemoryStatefulResponsesBacking();
  return {
    createStore(policy: ResponsesStatePolicy, store: boolean | undefined): StatefulResponsesStore {
      const durable = policy.retentionSeconds === 0 ? null : new RepoStatefulResponsesBacking(getRepo);
      // Session-local state is the first store:true collision gate. Writing it
      // first prevents a rejected local history from creating a durable row.
      const reads = durable === null ? [local] : [local, durable];
      const writes = durable === null || store === false ? [local] : [local, durable];
      return new LayeredStatefulResponsesStore({
        apiKeyId: policy.apiKeyId,
        stateEpoch: policy.stateEpoch,
        retentionSeconds: policy.retentionSeconds === 0 ? null : policy.retentionSeconds,
        reads,
        writes,
      });
    },
  };
};
