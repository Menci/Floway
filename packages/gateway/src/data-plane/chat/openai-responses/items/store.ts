import { createOpenAIResponsesStorageKey, hashOpenAIResponsesItem, openaiResponsesItemId } from './identity.ts';
import { getRepo } from '../../../../repo/index.ts';
import { assertSameStoredOpenAIResponsesItem, cloneStoredOpenAIResponsesItem, cloneStoredOpenAIResponsesSnapshot, compareOpenAIResponsesItemsByFreshness, scopedOpenAIResponsesKey } from '../../../../repo/openai-responses-clone.ts';
import { quantizeOpenAIResponsesRefreshedAt, openaiResponsesStateCutoff } from '../../../../repo/openai-responses-retention.ts';
import type { ApiKey, Repo, StoredOpenAIResponsesItem, StoredOpenAIResponsesSnapshot } from '../../../../repo/types.ts';
import type { OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

interface StatefulOpenAIResponsesItemLookup {
  readonly apiKeyId: string;
  readonly ids: readonly string[];
  readonly itemHashes: readonly string[];
}

interface StatefulOpenAIResponsesBacking {
  lookupItems(query: StatefulOpenAIResponsesItemLookup): Promise<StoredOpenAIResponsesItem[]>;
  insertItems(items: readonly StoredOpenAIResponsesItem[]): Promise<void>;
  refreshItems(items: readonly StoredOpenAIResponsesItem[], refreshedAt: number): Promise<void>;
  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredOpenAIResponsesSnapshot | null>;
  insertSnapshot(snapshot: StoredOpenAIResponsesSnapshot): Promise<void>;
}

interface LayeredStatefulOpenAIResponsesStoreOptions {
  readonly apiKeyId: string;
  readonly reads: readonly StatefulOpenAIResponsesBacking[];
  readonly writes: readonly StatefulOpenAIResponsesBacking[];
}

type OpenAIResponsesSnapshotMode = 'append' | 'replace';

export interface StatefulOpenAIResponsesStore {
  readonly apiKeyId: string;
  readonly writesState: boolean;
  loadSnapshot(id: string): Promise<StoredOpenAIResponsesSnapshot | null>;
  loadInputItems(sourceItems: readonly OpenAIResponsesInputItem[], inputItemsToStage: readonly OpenAIResponsesInputItem[]): Promise<void>;
  getItemById(id: string): StoredOpenAIResponsesItem | undefined;
  stageInputItems(items: readonly OpenAIResponsesInputItem[]): Promise<void>;
  persistOutputItem(row: StoredOpenAIResponsesItem): Promise<void>;
  commitSnapshot(responseId: string, mode: OpenAIResponsesSnapshotMode, outputItemIds: readonly string[]): Promise<void>;
  // Per-attempt transient state. `beginAttempt` reseeds the private-payload
  // scratchpad from hydrated items; a server tool can add server-only state
  // during the turn and output capture persists it with the exact wire item.
  beginAttempt(privatePayloads: ReadonlyMap<string, unknown>): void;
  registerPrivatePayload(id: string, privatePayload: unknown): void;
  getPrivatePayload(id: string): unknown;
}

export class LayeredStatefulOpenAIResponsesStore implements StatefulOpenAIResponsesStore {
  private readonly loadedItems = new Map<string, StoredOpenAIResponsesItem>();
  private readonly loadedByItemHash = new Map<string, StoredOpenAIResponsesItem>();
  private readonly stagedInputItemIds: string[] = [];
  private previousSnapshotItemIds: string[] = [];
  private readonly committedItemIds = new Set<string>();
  private readonly privatePayloads = new Map<string, unknown>();
  private readonly inputItemHashes = new WeakMap<OpenAIResponsesInputItem, string>();

  constructor(private readonly options: LayeredStatefulOpenAIResponsesStoreOptions) {}

  get apiKeyId(): string {
    return this.options.apiKeyId;
  }

  get writesState(): boolean {
    return this.options.writes.length > 0;
  }

  async loadSnapshot(id: string): Promise<StoredOpenAIResponsesSnapshot | null> {
    for (const backing of this.options.reads) {
      const snapshot = await backing.lookupSnapshot(this.apiKeyId, id);
      if (snapshot === null) continue;
      await this.loadItems({ ids: snapshot.itemIds, itemHashes: [] });
      if (!snapshot.itemIds.every(itemId => this.loadedItems.has(itemId))) continue;
      if (this.options.writes.length > 0) {
        const refreshedAt = quantizeOpenAIResponsesRefreshedAt(Date.now());
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
      return cloneStoredOpenAIResponsesSnapshot(snapshot);
    }
    return null;
  }

  async loadInputItems(
    sourceItems: readonly OpenAIResponsesInputItem[],
    inputItemsToStage: readonly OpenAIResponsesInputItem[],
  ): Promise<void> {
    const ids = new Set<string>();
    for (const item of sourceItems) {
      const id = openaiResponsesItemId(item);
      if (id !== null) ids.add(id);
    }
    const itemHashes = new Set<string>();
    for (const item of this.writesState ? inputItemsToStage : []) {
      if (item.type === 'item_reference' || item.type === 'compaction_trigger') continue;
      if (openaiResponsesItemId(item) !== null) continue;
      itemHashes.add(await this.hashInputItem(item));
    }
    await this.loadItems({ ids: [...ids], itemHashes: [...itemHashes] });
  }

  getItemById(id: string): StoredOpenAIResponsesItem | undefined {
    const row = this.loadedItems.get(id);
    return row === undefined ? undefined : cloneStoredOpenAIResponsesItem(row);
  }

  async stageInputItems(items: readonly OpenAIResponsesInputItem[]): Promise<void> {
    if (!this.writesState) return;
    for (const item of items) await this.stageInputItem(item);
  }

  async persistOutputItem(row: StoredOpenAIResponsesItem): Promise<void> {
    if (!this.writesState) return;
    const cloned = cloneStoredOpenAIResponsesItem({
      ...row,
      refreshedAt: quantizeOpenAIResponsesRefreshedAt(row.refreshedAt),
    });
    await this.commitItems([cloned]);
    this.rememberItem(cloned);
  }

  async commitSnapshot(responseId: string, mode: OpenAIResponsesSnapshotMode, outputItemIds: readonly string[]): Promise<void> {
    if (this.options.writes.length === 0) return;
    const itemIds = mode === 'replace'
      ? [...outputItemIds]
      : [...this.previousSnapshotItemIds, ...this.stagedInputItemIds, ...outputItemIds];
    if (itemIds.length === 0) return;
    const uniqueRows = [...new Set(itemIds)].map(id => {
      const row = this.loadedItems.get(id);
      if (row === undefined) throw new Error(`OpenAI Responses snapshot item disappeared before commit: ${id}`);
      return row;
    });
    await this.commitItems(uniqueRows);
    const refreshedAt = quantizeOpenAIResponsesRefreshedAt(Date.now());
    const staleRows = uniqueRows.filter(row => row.refreshedAt < refreshedAt);
    if (staleRows.length > 0) {
      await Promise.all(this.options.writes.map(write => write.refreshItems(staleRows, refreshedAt)));
      for (const row of staleRows) {
        if (row.refreshedAt < refreshedAt) row.refreshedAt = refreshedAt;
      }
    }
    const snapshotRefreshedAt = Math.min(...uniqueRows.map(row => row.refreshedAt));
    const snapshot: StoredOpenAIResponsesSnapshot = {
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

  private async stageInputItem(item: OpenAIResponsesInputItem): Promise<void> {
    if (item.type === 'compaction_trigger') return;
    if (item.type === 'item_reference') {
      const row = this.loadedItems.get(item.id);
      if (row === undefined) throw new Error(`Cannot stage unresolved OpenAI Responses item_reference id=${item.id}`);
      this.stagedInputItemIds.push(row.id);
      return;
    }

    const id = openaiResponsesItemId(item);
    if (id !== null) {
      const row = this.loadedItems.get(id);
      if (row !== undefined) {
        this.stagedInputItemIds.push(row.id);
        return;
      }

      const created: StoredOpenAIResponsesItem = {
        id,
        apiKeyId: this.apiKeyId,
        payload: { item },
        itemHash: await this.hashInputItem(item),
        refreshedAt: quantizeOpenAIResponsesRefreshedAt(Date.now()),
      };
      this.stagedInputItemIds.push(id);
      this.rememberItem(created);
      return;
    }

    const itemHash = await this.hashInputItem(item);
    const existing = this.loadedByItemHash.get(itemHash);
    if (existing !== undefined) {
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const row: StoredOpenAIResponsesItem = {
      id: createOpenAIResponsesStorageKey(),
      apiKeyId: this.apiKeyId,
      payload: { item },
      itemHash,
      refreshedAt: quantizeOpenAIResponsesRefreshedAt(Date.now()),
    };
    this.stagedInputItemIds.push(row.id);
    this.rememberItem(row);
  }

  private async hashInputItem(item: OpenAIResponsesInputItem): Promise<string> {
    const cached = this.inputItemHashes.get(item);
    if (cached !== undefined) return cached;
    const hash = await hashOpenAIResponsesItem(item);
    this.inputItemHashes.set(item, hash);
    return hash;
  }

  private rememberItem(row: StoredOpenAIResponsesItem): void {
    const cloned = cloneStoredOpenAIResponsesItem(row);
    const existing = this.loadedItems.get(cloned.id);
    if (existing !== undefined && existing.refreshedAt >= cloned.refreshedAt) return;
    this.loadedItems.set(cloned.id, cloned);
    const byHash = this.loadedByItemHash.get(cloned.itemHash);
    if (byHash === undefined || compareOpenAIResponsesItemsByFreshness(cloned, byHash) < 0) {
      this.loadedByItemHash.set(cloned.itemHash, cloned);
    }
  }

  private async commitItems(rows: readonly StoredOpenAIResponsesItem[]): Promise<void> {
    const pending = rows.flatMap(row => {
      if (!this.committedItemIds.has(row.id)) return [row];
      const committed = this.loadedItems.get(row.id);
      if (committed === undefined) throw new Error(`Committed OpenAI Responses item disappeared from request state: ${row.id}`);
      assertSameStoredOpenAIResponsesItem(row, committed);
      return [];
    });
    if (pending.length === 0) return;
    for (const write of this.options.writes) await write.insertItems(pending);
    for (const row of pending) this.committedItemIds.add(row.id);
  }
}

export class RepoStatefulOpenAIResponsesBacking implements StatefulOpenAIResponsesBacking {
  private readonly earliestVisibleCutoff: number;

  constructor(
    private readonly getRepo: () => Repo,
    requestStartedAt: number,
    retentionSeconds: number,
  ) {
    this.earliestVisibleCutoff = openaiResponsesStateCutoff(requestStartedAt, retentionSeconds);
  }

  async lookupItems(query: StatefulOpenAIResponsesItemLookup): Promise<StoredOpenAIResponsesItem[]> {
    const [byId, byItemHash] = await Promise.all([
      this.getRepo().openaiResponsesItems.lookupMany(query.apiKeyId, query.ids, this.earliestVisibleCutoff),
      this.getRepo().openaiResponsesItems.lookupManyByItemHash(query.apiKeyId, query.itemHashes, this.earliestVisibleCutoff),
    ]);
    const rows = new Map<string, StoredOpenAIResponsesItem>();
    for (const row of [...byId, ...byItemHash]) rows.set(scopedOpenAIResponsesKey(row.apiKeyId, row.id), row);
    return [...rows.values()];
  }

  async insertItems(items: readonly StoredOpenAIResponsesItem[]): Promise<void> {
    await this.getRepo().openaiResponsesItems.insertMany(items, this.earliestVisibleCutoff);
  }

  async refreshItems(items: readonly StoredOpenAIResponsesItem[], refreshedAt: number): Promise<void> {
    await this.getRepo().openaiResponsesItems.refreshMany(items, refreshedAt, this.earliestVisibleCutoff);
  }

  async lookupSnapshot(apiKeyId: string, id: string): Promise<StoredOpenAIResponsesSnapshot | null> {
    return await this.getRepo().openaiResponsesSnapshots.lookup(apiKeyId, id, this.earliestVisibleCutoff);
  }

  async insertSnapshot(snapshot: StoredOpenAIResponsesSnapshot): Promise<void> {
    await this.getRepo().openaiResponsesSnapshots.insert(snapshot);
  }
}

export class MemoryStatefulOpenAIResponsesBacking implements StatefulOpenAIResponsesBacking {
  private readonly items = new Map<string, StoredOpenAIResponsesItem>();
  private readonly snapshots = new Map<string, StoredOpenAIResponsesSnapshot>();

  lookupItems(query: StatefulOpenAIResponsesItemLookup): Promise<StoredOpenAIResponsesItem[]> {
    const ids = new Set(query.ids);
    const hashes = new Set(query.itemHashes);
    return Promise.resolve([...this.items.values()]
      .filter(row => row.apiKeyId === query.apiKeyId && (ids.has(row.id) || hashes.has(row.itemHash)))
      .map(cloneStoredOpenAIResponsesItem)
      .toSorted(compareOpenAIResponsesItemsByFreshness));
  }

  async insertItems(items: readonly StoredOpenAIResponsesItem[]): Promise<void> {
    const quantizedItems = items.map(item => ({
      ...item,
      refreshedAt: quantizeOpenAIResponsesRefreshedAt(item.refreshedAt),
    }));
    const pending = new Map<string, StoredOpenAIResponsesItem>();
    for (const item of quantizedItems) {
      const key = scopedOpenAIResponsesKey(item.apiKeyId, item.id);
      const existing = pending.get(key) ?? this.items.get(key);
      if (existing !== undefined) assertSameStoredOpenAIResponsesItem(item, existing);
      else pending.set(key, item);
    }
    for (const [key, item] of pending) this.items.set(key, cloneStoredOpenAIResponsesItem(item));
    for (const item of quantizedItems) {
      const stored = this.items.get(scopedOpenAIResponsesKey(item.apiKeyId, item.id))!;
      if (stored.refreshedAt < item.refreshedAt) stored.refreshedAt = item.refreshedAt;
    }
  }

  async refreshItems(items: readonly StoredOpenAIResponsesItem[], refreshedAt: number): Promise<void> {
    const quantizedRefreshedAt = quantizeOpenAIResponsesRefreshedAt(refreshedAt);
    const existing = items.map(item => this.items.get(scopedOpenAIResponsesKey(item.apiKeyId, item.id)));
    const missingIndex = existing.findIndex(item => item === undefined);
    if (missingIndex !== -1) {
      throw new Error(`OpenAI Responses item disappeared before retention refresh: ${items[missingIndex].id}`);
    }
    for (let index = 0; index < existing.length; index += 1) {
      assertSameStoredOpenAIResponsesItem(items[index], existing[index]!);
      if (existing[index]!.refreshedAt < quantizedRefreshedAt) existing[index]!.refreshedAt = quantizedRefreshedAt;
    }
  }

  lookupSnapshot(apiKeyId: string, id: string): Promise<StoredOpenAIResponsesSnapshot | null> {
    const snapshot = this.snapshots.get(scopedOpenAIResponsesKey(apiKeyId, id));
    return Promise.resolve(snapshot === undefined ? null : cloneStoredOpenAIResponsesSnapshot(snapshot));
  }

  insertSnapshot(snapshot: StoredOpenAIResponsesSnapshot): Promise<void> {
    const quantized = {
      ...snapshot,
      refreshedAt: quantizeOpenAIResponsesRefreshedAt(snapshot.refreshedAt),
    };
    const key = scopedOpenAIResponsesKey(quantized.apiKeyId, quantized.id);
    const existing = this.snapshots.get(key);
    if (existing === undefined || quantized.refreshedAt > existing.refreshedAt) {
      this.snapshots.set(key, cloneStoredOpenAIResponsesSnapshot(quantized));
    }
    return Promise.resolve();
  }

  // Beyond `StatefulOpenAIResponsesBacking`: the spec scopes eviction to the
  // connection-local cache, so the delete path deliberately stops at this
  // in-memory backing rather than becoming a contract every backing — the
  // durable one included — has to answer for.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L127
  evictSnapshot(apiKeyId: string, id: string): void {
    this.snapshots.delete(scopedOpenAIResponsesKey(apiKeyId, id));
  }
}

type OpenAIResponsesStatePolicy = Pick<ApiKey, 'id' | 'openaiResponsesRetentionSeconds'>;

const createDurableBacking = (apiKey: OpenAIResponsesStatePolicy, requestStartedAt: number): RepoStatefulOpenAIResponsesBacking | null =>
  apiKey.openaiResponsesRetentionSeconds === 0
    ? null
    : new RepoStatefulOpenAIResponsesBacking(getRepo, requestStartedAt, apiKey.openaiResponsesRetentionSeconds);

export const createOpenAIResponsesHttpStore = (apiKey: OpenAIResponsesStatePolicy, requestStartedAt: number, store: boolean | undefined): StatefulOpenAIResponsesStore => {
  const durable = createDurableBacking(apiKey, requestStartedAt);
  return new LayeredStatefulOpenAIResponsesStore({
    apiKeyId: apiKey.id,
    reads: durable === null ? [] : [durable],
    writes: durable === null || store === false ? [] : [durable],
  });
};

// Non-OpenAI-Responses sources (Anthropic Messages / Gemini generateContent / OpenAI Chat
// Completions) never persist OpenAI Responses items, even when translation enters an OpenAI
// Responses attempt — but the
// server-tool shim's request-private payload scratchpad lives on the store, and
// it is what will write there once that shim is a stage. So they get a store
// with no backing: it holds per-attempt state in memory and reads/writes nothing
// durable, keeping the store present on every chat ctx.
export const createNonOpenAIResponsesSourceStore = (apiKeyId: string): StatefulOpenAIResponsesStore =>
  new LayeredStatefulOpenAIResponsesStore({ apiKeyId, reads: [], writes: [] });

export const createOpenAIResponsesWsSession = (): {
  createStore(apiKey: OpenAIResponsesStatePolicy, requestStartedAt: number, store: boolean | undefined): StatefulOpenAIResponsesStore;
  evictSnapshot(apiKeyId: string, id: string): void;
} => {
  // "Servers SHOULD keep the most recent previous-response state in
  // connection-local memory for the active WebSocket. […] With `store=false`,
  // there is no persisted fallback; if the referenced response is not
  // available from connection-local state, the server MUST fail the turn with
  // an error whose code is `previous_response_not_found`."
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L125
  const local = new MemoryStatefulOpenAIResponsesBacking();
  return {
    createStore(apiKey: OpenAIResponsesStatePolicy, requestStartedAt: number, store: boolean | undefined): StatefulOpenAIResponsesStore {
      const durable = createDurableBacking(apiKey, requestStartedAt);
      // Session-local state is the first store:true collision gate. Writing it
      // first prevents a rejected local history from creating a durable row.
      const writes = store === false || durable === null ? [local] : [local, durable];
      return new LayeredStatefulOpenAIResponsesStore({
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
