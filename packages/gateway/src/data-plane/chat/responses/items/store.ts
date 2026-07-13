import { createStoredResponsesItemId, hashResponsesItemContent, hashResponsesItemEncryptedContent, isStoredResponsesItemId, responsesItemEncryptedContent, responsesItemId } from './format.ts';
import { getRepo } from '../../../../repo/index.ts';
import {
  cloneStoredResponsesItem,
  cloneStoredResponsesItemMetadata,
  cloneStoredResponsesSnapshot,
  compareResponsesItemsByFreshness as compareItemsByFreshness,
  responsesItemStoreKey as scopedKey,
  storedResponsesItemMetadata,
} from '../../../../repo/responses-clone.ts';
import type { Repo, StoredResponsesItem, StoredResponsesItemMetadata, StoredResponsesItemPayload, StoredResponsesItemPayloadRecord, StoredResponsesSnapshot } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface StatefulResponsesItemLookup {
  readonly apiKeyId: string | null;
  readonly ids: readonly string[];
  readonly contentHashes: readonly string[];
  readonly encryptedContentHashes: readonly string[];
}

export interface StatefulResponsesItemLookupResult {
  readonly metadata: StoredResponsesItemMetadata;
  readonly durable: boolean;
}

export interface StatefulResponsesBacking {
  lookupItems(query: StatefulResponsesItemLookup): Promise<StatefulResponsesItemLookupResult[]>;
  lookupPayloads(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItemPayloadRecord[]>;
  insertItems(items: readonly StoredResponsesItem[], options: { readonly durable: boolean }): Promise<void>;
  fillPayloads(items: readonly StoredResponsesItem[], options: { readonly durable: boolean }): Promise<void>;
  markDurable?(apiKeyId: string | null, id: string): void;
  refreshItems(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<void>;
  lookupSnapshot(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null>;
  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void>;
  refreshSnapshot(apiKeyId: string | null, id: string, refreshedAt: number): Promise<void>;
}

export interface StatefulResponsesWriteTarget {
  readonly backing: StatefulResponsesBacking;
  readonly durable: boolean;
}

export interface LayeredStatefulResponsesStoreOptions {
  readonly apiKeyId: string | null;
  readonly reads: readonly StatefulResponsesBacking[];
  readonly itemWrites: readonly StatefulResponsesWriteTarget[];
  readonly snapshotWrites: readonly StatefulResponsesWriteTarget[];
  readonly stageInputs: boolean;
  // Gates durable payload persistence. When false, output item rows reach durable
  // backings with null payload (metadata-only) and snapshot writes are skipped.
  // In-memory backings keep full payloads regardless — see StatefulResponsesStore.
  readonly shouldStorePayload?: boolean;
}

// How a Responses turn should commit its snapshot:
//   - 'append'  : conversation continuation — previous snapshot + this turn's
//                 input + this turn's output. Default for a normal generate.
//   - 'replace' : the turn's output IS the new conversation — drop prior
//                 history and the stitched-in input. Used when the output is
//                 a self-contained compaction envelope so referencing this
//                 response via `previous_response_id` replays only the
//                 retained messages + the encrypted compaction blob, not the
//                 original full history.
//
// The mode is derived inside `wrapResponsesOutputForStorage` by observing the
// output stream, so callers do not pass it. Skipping the snapshot entirely is
// expressed at the store layer via an empty `snapshotWrites` configuration
// (see `createNonResponsesSourceStore` and the `store=false` branch of
// `createResponsesHttpStore`).
export type ResponsesSnapshotMode = 'append' | 'replace';

export interface StatefulResponsesStore {
  readonly apiKeyId: string | null;
  // Gates *durable* payload persistence specifically. When false (HTTP store=false),
  // durable item rows are written metadata-only (null payload) and no snapshot is
  // committed. WS session-scoped in-memory writes always retain full payloads
  // regardless of this flag — they live for the WS lifetime only and never reach
  // durable storage.
  readonly shouldStorePayload: boolean;
  loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null>;
  loadInputItems<TSourceItems>(options: {
    readonly sourceItems: TSourceItems;
    readonly view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>;
    readonly inputItemsToStage?: readonly ResponsesInputItem[];
  }): Promise<void>;
  getItemById(id: string): StoredResponsesItemMetadata | undefined;
  getItemsByEncryptedContentHash(hash: string): StoredResponsesItemMetadata[];
  loadItemPayloads(items: readonly StoredResponsesItemMetadata[]): Promise<ReadonlyMap<string, StoredResponsesItemPayload>>;
  touchItem(id: string): void;
  stageInputItems(items: readonly ResponsesInputItem[]): Promise<void>;
  beginAttempt(privatePayloads: ReadonlyMap<string, unknown>): void;
  addSyntheticItem(id: string, privatePayload?: unknown): void;
  isSyntheticItem(id: string): boolean;
  getPrivatePayload(id: string): unknown;
  stageOutputItem(row: StoredResponsesItem): void;
  commitOutputItems(): Promise<void>;
  commitSnapshot(responseId: string, mode: ResponsesSnapshotMode): Promise<void>;
  refreshTouchedItems(): Promise<void>;
}

export class LayeredStatefulResponsesStore implements StatefulResponsesStore {
  private readonly loadedItemsById = new Map<string, StoredResponsesItemMetadata>();
  private readonly loadedItemsByContentHash = new Map<string, StoredResponsesItemMetadata[]>();
  private readonly loadedItemsByEncryptedContentHash = new Map<string, StoredResponsesItemMetadata[]>();
  private readonly payloadSourcesById = new Map<string, StatefulResponsesBacking>();
  private readonly stagedPayloadsById = new Map<string, StoredResponsesItemPayload>();
  private readonly privatePayload = new Map<string, unknown>();
  private readonly syntheticItemIds = new Set<string>();
  private readonly snapshotsById = new Map<string, StoredResponsesSnapshot>();
  private readonly stagedInputItems = new Map<string, StoredResponsesItem>();
  private readonly stagedInputItemIds: string[] = [];
  private previousSnapshotItemIds: string[] = [];
  private readonly stagedOutputItems = new Map<string, StoredResponsesItem>();
  private readonly stagedOutputItemIds: string[] = [];
  private readonly committedItemIds = new Set<string>();
  private readonly payloadUpgradeIds = new Set<string>();
  private readonly committedSnapshotIds = new Set<string>();
  private readonly touchedItemIds = new Set<string>();
  private readonly refreshedItemIds = new Set<string>();
  private readonly durableItemIds = new Set<string>();

  constructor(private readonly options: LayeredStatefulResponsesStoreOptions) {}

  get apiKeyId(): string | null {
    return this.options.apiKeyId;
  }

  get shouldStorePayload(): boolean {
    return this.options.shouldStorePayload !== false;
  }

  async loadSnapshot(id: string): Promise<StoredResponsesSnapshot | null> {
    const cached = this.snapshotsById.get(id);
    if (cached) {
      this.previousSnapshotItemIds = [...cached.itemIds];
      return cloneStoredResponsesSnapshot(cached);
    }

    for (const backing of this.options.reads) {
      const snapshot = await backing.lookupSnapshot(this.options.apiKeyId, id);
      if (snapshot === null) continue;
      await this.loadItems({ ids: snapshot.itemIds, contentHashes: [], encryptedContentHashes: [] });
      if (!snapshot.itemIds.every(itemId => {
        const row = this.loadedItemsById.get(itemId);
        return row !== undefined && isReplayableSnapshotMetadata(row);
      })) continue;
      this.rememberSnapshot(snapshot);
      this.previousSnapshotItemIds = [...snapshot.itemIds];
      for (const itemId of snapshot.itemIds) this.touchedItemIds.add(itemId);
      await Promise.all(this.options.snapshotWrites.map(write => write.backing.refreshSnapshot(this.options.apiKeyId, id, Date.now())));
      return cloneStoredResponsesSnapshot(snapshot);
    }
    return null;
  }

  async loadInputItems<TSourceItems>(options: {
    readonly sourceItems: TSourceItems;
    readonly view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>;
    readonly inputItemsToStage?: readonly ResponsesInputItem[];
  }): Promise<void> {
    const ids = new Set<string>();
    const encryptedContents = new Set<string>();
    await options.view.visitAsResponsesItems(options.sourceItems, item => {
      const id = responsesItemId(item);
      if (id !== null && isStoredResponsesItemId(id)) ids.add(id);
      const encryptedContent = responsesItemEncryptedContent(item);
      if (encryptedContent !== null) encryptedContents.add(encryptedContent);
    });

    const contentHashes = new Set<string>();
    for (const item of options.inputItemsToStage ?? []) contentHashes.add(await hashResponsesItemContent(item));

    const encryptedContentHashes = new Set<string>();
    for (const encryptedContent of encryptedContents) encryptedContentHashes.add(await hashResponsesItemEncryptedContent(encryptedContent));

    await this.loadItems({
      ids: [...ids],
      contentHashes: [...contentHashes],
      encryptedContentHashes: [...encryptedContentHashes],
    });
  }

  getItemById(id: string): StoredResponsesItemMetadata | undefined {
    const row = this.loadedItemsById.get(id) ?? this.stagedInputItems.get(id) ?? this.stagedOutputItems.get(id);
    if (row) this.touchItem(row.id);
    return row ? cloneStoredResponsesItemMetadata('hasPayload' in row ? row : storedResponsesItemMetadata(row)) : undefined;
  }

  getItemsByEncryptedContentHash(hash: string): StoredResponsesItemMetadata[] {
    return (this.loadedItemsByEncryptedContentHash.get(hash) ?? []).map(cloneStoredResponsesItemMetadata);
  }

  async loadItemPayloads(items: readonly StoredResponsesItemMetadata[]): Promise<ReadonlyMap<string, StoredResponsesItemPayload>> {
    const payloads = new Map<string, StoredResponsesItemPayload>();
    const groups = new Map<StatefulResponsesBacking, StoredResponsesItemMetadata[]>();
    for (const item of items) {
      if (!item.hasPayload || payloads.has(item.id)) continue;
      const staged = this.stagedPayloadsById.get(item.id);
      if (staged !== undefined) {
        payloads.set(item.id, staged);
        continue;
      }
      const source = this.payloadSourcesById.get(item.id);
      if (source === undefined) throw new Error(`Stored Responses payload source missing for id=${item.id}`);
      const rows = groups.get(source) ?? [];
      rows.push(item);
      groups.set(source, rows);
    }
    for (const [source, metadata] of groups) {
      const records = await source.lookupPayloads(this.options.apiKeyId, metadata.map(item => item.id));
      const byId = new Map(records.map(record => [record.id, record.payload]));
      for (const item of metadata) {
        const payload = byId.get(item.id);
        if (payload === undefined) throw new Error(`Stored Responses payload disappeared during hydration for id=${item.id}`);
        payloads.set(item.id, payload);
      }
    }
    return payloads;
  }

  touchItem(id: string): void {
    this.touchedItemIds.add(id);
  }

  async stageInputItems(items: readonly ResponsesInputItem[]): Promise<void> {
    if (!this.options.stageInputs) return;
    for (const item of items) await this.stageInputItem(item);
  }

  beginAttempt(privatePayloads: ReadonlyMap<string, unknown>): void {
    this.stagedOutputItems.clear();
    this.stagedOutputItemIds.length = 0;
    this.privatePayload.clear();
    this.syntheticItemIds.clear();
    for (const [wireId, payload] of privatePayloads) this.privatePayload.set(wireId, payload);
  }

  addSyntheticItem(id: string, privatePayload?: unknown): void {
    this.syntheticItemIds.add(id);
    if (privatePayload !== undefined) this.privatePayload.set(id, privatePayload);
  }

  isSyntheticItem(id: string): boolean {
    return this.syntheticItemIds.has(id);
  }

  getPrivatePayload(id: string): unknown {
    return this.privatePayload.get(id);
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
    if (this.options.snapshotWrites.length === 0 || this.committedSnapshotIds.has(responseId)) return;
    await this.commitItems([...this.stagedInputItems.values(), ...this.stagedOutputItems.values()]);
    const itemIds = mode === 'replace'
      ? [...this.stagedOutputItemIds]
      : [...this.previousSnapshotItemIds, ...this.stagedInputItemIds, ...this.stagedOutputItemIds];
    if (itemIds.length === 0) return;

    this.assertReplayableSnapshotItems(itemIds);
    const now = Date.now();
    const snapshot: StoredResponsesSnapshot = {
      id: responseId,
      apiKeyId: this.options.apiKeyId,
      itemIds,
      createdAt: now,
      refreshedAt: now,
    };
    await Promise.all(this.options.snapshotWrites
      .filter(write => !write.durable || itemIds.every(id => this.durableItemIds.has(id)))
      .map(write => write.backing.insertSnapshot(snapshot)));
    this.rememberSnapshot(snapshot);
    this.committedSnapshotIds.add(responseId);
  }

  private async loadItems(query: { ids: readonly string[]; contentHashes: readonly string[]; encryptedContentHashes: readonly string[] }): Promise<void> {
    let ids = query.ids.filter(id => !this.loadedItemsById.has(id));
    const contentHashes = [...new Set(query.contentHashes)];
    const encryptedContentHashes = [...new Set(query.encryptedContentHashes)];

    for (const backing of this.options.reads) {
      if (ids.length === 0 && contentHashes.length === 0 && encryptedContentHashes.length === 0) return;
      const results = await backing.lookupItems({
        apiKeyId: this.options.apiKeyId,
        ids,
        contentHashes,
        encryptedContentHashes,
      });
      for (const result of results) this.rememberItem(result.metadata, { durable: result.durable, source: backing });
      ids = ids.filter(id => !this.loadedItemsById.has(id));
    }
  }

  private async stageInputItem(item: ResponsesInputItem): Promise<void> {
    // `compaction_trigger` is a per-request control signal, not content:
    // payload-free, idless, never persisted in codex's own rollout/history,
    // and never re-sent on subsequent turns. The output of such a turn is a
    // self-contained `compaction` envelope which wrap detects and commits as
    // snapshot mode 'replace', so this row would have no reader. Skipping it
    // also keeps `createStoredResponsesItemId` from minting a prefix for a
    // type that never needs one.
    if (item.type === 'compaction_trigger') return;

    if (item.type === 'item_reference') {
      const row = this.getItemById(item.id);
      if (row === undefined) throw new Error(`Cannot stage unresolved Responses item_reference id=${item.id}`);
      this.stagedInputItemIds.push(row.id);
      return;
    }

    const storedId = responsesItemId(item);
    if (storedId !== null && isStoredResponsesItemId(storedId)) {
      const row = this.getItemById(storedId);
      if (row !== undefined) {
        if (row.hasPayload) {
          this.stagedInputItemIds.push(row.id);
          return;
        }
        await this.stagePayloadUpgrade(row, item, responsesItemEncryptedContent(item));
        return;
      }
    }

    const encryptedContent = responsesItemEncryptedContent(item);
    if (encryptedContent !== null) {
      const row = this.getItemsByEncryptedContentHash(await hashResponsesItemEncryptedContent(encryptedContent))
        .find(candidate => candidate.itemType === item.type);
      if (row !== undefined) {
        this.touchItem(row.id);
        if (row.hasPayload) {
          this.stagedInputItemIds.push(row.id);
          return;
        }
        await this.stagePayloadUpgrade(row, item, encryptedContent);
        return;
      }
    }

    const contentHash = await hashResponsesItemContent(item);
    const existing = this.reusableItemByContentHash(contentHash);
    if (existing) {
      this.touchItem(existing.id);
      this.stagedInputItemIds.push(existing.id);
      return;
    }

    const now = Date.now();
    const row: StoredResponsesItem = {
      id: createStoredResponsesItemId(item.type),
      apiKeyId: this.options.apiKeyId,
      upstreamId: null,
      upstreamItemId: null,
      itemType: item.type,
      origin: 'input',
      payload: { item: structuredClone(item) },
      contentHash,
      encryptedContentHash: encryptedContent === null ? null : await hashResponsesItemEncryptedContent(encryptedContent),
      createdAt: now,
      refreshedAt: now,
    };
    this.stagedInputItems.set(row.id, row);
    this.stagedInputItemIds.push(row.id);
    this.rememberItem(row, { durable: this.durableItemIds.has(row.id) });
  }

  private async stagePayloadUpgrade(row: StoredResponsesItemMetadata, item: ResponsesInputItem, encryptedContent: string | null): Promise<void> {
    const now = Date.now();
    const { hasPayload: _hasPayload, ...metadata } = row;
    const upgraded: StoredResponsesItem = {
      ...metadata,
      payload: { item: structuredClone(item) },
      contentHash: await hashResponsesItemContent(item),
      encryptedContentHash: encryptedContent === null ? row.encryptedContentHash : await hashResponsesItemEncryptedContent(encryptedContent),
      createdAt: now,
      refreshedAt: now,
    };
    this.stagedInputItems.set(upgraded.id, upgraded);
    this.payloadUpgradeIds.add(upgraded.id);
    this.stagedInputItemIds.push(upgraded.id);
    this.rememberItem(upgraded);
  }

  private reusableItemByContentHash(hash: string): StoredResponsesItemMetadata | undefined {
    const staged = [...this.stagedInputItems.values(), ...this.stagedOutputItems.values()].find(row => row.contentHash === hash);
    if (staged) return storedResponsesItemMetadata(staged);
    return this.loadedItemsByContentHash.get(hash)?.find(row => row.hasPayload);
  }

  private rememberItem(
    row: StoredResponsesItem | StoredResponsesItemMetadata,
    options: { readonly durable?: boolean; readonly source?: StatefulResponsesBacking } = {},
  ): void {
    const metadata = cloneStoredResponsesItemMetadata('hasPayload' in row ? row : storedResponsesItemMetadata(row));
    this.loadedItemsById.set(metadata.id, metadata);
    if (!('hasPayload' in row) && row.payload !== null) this.stagedPayloadsById.set(row.id, structuredClone(row.payload));
    if (metadata.hasPayload && options.source !== undefined) this.payloadSourcesById.set(metadata.id, options.source);
    if (options.durable === true) this.durableItemIds.add(metadata.id);
    if (metadata.contentHash !== null) pushByHash(this.loadedItemsByContentHash, metadata.contentHash, metadata);
    if (metadata.encryptedContentHash !== null) pushByHash(this.loadedItemsByEncryptedContentHash, metadata.encryptedContentHash, metadata);
  }

  private rememberSnapshot(snapshot: StoredResponsesSnapshot): void {
    this.snapshotsById.set(snapshot.id, cloneStoredResponsesSnapshot(snapshot));
  }

  private assertReplayableSnapshotItems(itemIds: readonly string[]): void {
    const seen = new Set<string>();
    for (const id of itemIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.loadedItemsById.get(id)
        ?? (this.stagedInputItems.has(id) ? storedResponsesItemMetadata(this.stagedInputItems.get(id)!) : undefined)
        ?? (this.stagedOutputItems.has(id) ? storedResponsesItemMetadata(this.stagedOutputItems.get(id)!) : undefined);
      if (row === undefined || !isReplayableSnapshotMetadata(row)) {
        throw new Error(`Cannot persist Responses snapshot with non-replayable item id=${id}`);
      }
    }
  }

  private async commitItems(rows: readonly StoredResponsesItem[]): Promise<void> {
    const pending = rows.filter(row => !this.committedItemIds.has(row.id));
    if (pending.length > 0) {
      await Promise.all(this.options.itemWrites.map(async write => {
        const writable = write.durable ? pending.filter(row => this.needsDurableWrite(row)) : pending;
        const payloadUpgrades = writable.filter(row => this.payloadUpgradeIds.has(row.id) && (!write.durable || this.durableItemIds.has(row.id)));
        const inserts = writable.filter(row => !this.payloadUpgradeIds.has(row.id) || (write.durable && !this.durableItemIds.has(row.id)));
        const operations: Promise<unknown>[] = [];
        if (inserts.length > 0) operations.push(write.backing.insertItems(inserts, { durable: write.durable }));
        if (payloadUpgrades.length > 0) operations.push(write.backing.fillPayloads(payloadUpgrades, { durable: write.durable }));
        await Promise.all(operations);
        if (write.durable) {
          for (const row of writable) this.markDurable(row.apiKeyId, row.id);
        }
      }));
      for (const row of pending) this.committedItemIds.add(row.id);
    }
    await this.refreshTouchedItems();
  }

  private needsDurableWrite(row: StoredResponsesItem): boolean {
    return this.isDurableWriteEligible(row)
      && (!this.durableItemIds.has(row.id) || this.payloadUpgradeIds.has(row.id));
  }

  private isDurableWriteEligible(row: StoredResponsesItem): boolean {
    return this.durableItemIds.has(row.id)
      || this.stagedInputItems.has(row.id)
      || this.stagedOutputItems.has(row.id)
      || this.payloadUpgradeIds.has(row.id);
  }

  private markDurable(apiKeyId: string | null, id: string): void {
    this.durableItemIds.add(id);
    for (const write of this.options.itemWrites) {
      if (!write.durable) write.backing.markDurable?.(apiKeyId, id);
    }
  }

  async refreshTouchedItems(): Promise<void> {
    const ids = [...this.touchedItemIds].filter(id => !this.refreshedItemIds.has(id));
    if (ids.length === 0) return;
    const refreshedAt = Date.now();
    await Promise.all(this.options.itemWrites.map(write => {
      const writableIds = write.durable ? ids.filter(id => this.durableItemIds.has(id)) : ids;
      return write.backing.refreshItems(this.options.apiKeyId, writableIds, refreshedAt);
    }));
    for (const id of ids) this.refreshedItemIds.add(id);
  }
}

export class RepoStatefulResponsesBacking implements StatefulResponsesBacking {
  constructor(private readonly getRepo: () => Repo) {}

  private get repo(): Repo {
    return this.getRepo();
  }

  async lookupItems(query: StatefulResponsesItemLookup): Promise<StatefulResponsesItemLookupResult[]> {
    const [byId, byContentHash, byEncryptedContentHash] = await Promise.all([
      this.repo.responsesItems.lookupMany(query.apiKeyId, query.ids),
      this.repo.responsesItems.lookupManyByContentHash(query.apiKeyId, query.contentHashes),
      this.repo.responsesItems.lookupManyByEncryptedContentHash(query.apiKeyId, query.encryptedContentHashes),
    ]);
    const rowsByKey = new Map<string, StoredResponsesItemMetadata>();
    for (const row of [...byId, ...byContentHash, ...byEncryptedContentHash]) {
      rowsByKey.set(scopedKey(row.apiKeyId, row.id), cloneStoredResponsesItemMetadata(row));
    }
    return [...rowsByKey.values()].map(metadata => ({ metadata, durable: true }));
  }

  async lookupPayloads(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItemPayloadRecord[]> {
    return await this.repo.responsesItems.lookupPayloads(apiKeyId, ids);
  }

  async insertItems(items: readonly StoredResponsesItem[]): Promise<void> {
    await this.repo.responsesItems.insertMany(items);
  }

  async fillPayloads(items: readonly StoredResponsesItem[]): Promise<void> {
    await this.repo.responsesItems.fillPayloads(items);
  }

  async refreshItems(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<void> {
    await this.repo.responsesItems.refreshMany(apiKeyId, ids, refreshedAt);
  }

  async lookupSnapshot(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null> {
    return await this.repo.responsesSnapshots.lookup(apiKeyId, id);
  }

  async insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    await this.repo.responsesSnapshots.insert(snapshot);
  }

  async refreshSnapshot(apiKeyId: string | null, id: string, refreshedAt: number): Promise<void> {
    await this.repo.responsesSnapshots.refresh(apiKeyId, id, refreshedAt);
  }
}

export class MemoryStatefulResponsesBacking implements StatefulResponsesBacking {
  private readonly items = new Map<string, { row: StoredResponsesItem; durable: boolean }>();
  private readonly snapshots = new Map<string, StoredResponsesSnapshot>();

  lookupItems(query: StatefulResponsesItemLookup): Promise<StatefulResponsesItemLookupResult[]> {
    const ids = new Set(query.ids);
    const contentHashes = new Set(query.contentHashes);
    const encryptedContentHashes = new Set(query.encryptedContentHashes);
    return Promise.resolve([...this.items.values()]
      .filter(({ row }) =>
        row.apiKeyId === query.apiKeyId
        && (
          ids.has(row.id)
          || (row.contentHash !== null && contentHashes.has(row.contentHash))
          || (row.encryptedContentHash !== null && encryptedContentHashes.has(row.encryptedContentHash))
        ))
      .map(({ row, durable }) => ({ metadata: storedResponsesItemMetadata(row), durable }))
      .toSorted((a, b) => compareItemsByFreshness(a.metadata, b.metadata)));
  }

  lookupPayloads(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItemPayloadRecord[]> {
    const records: StoredResponsesItemPayloadRecord[] = [];
    for (const id of new Set(ids)) {
      const row = this.items.get(scopedKey(apiKeyId, id))?.row;
      if (row !== undefined && row.payload !== null) records.push({ id, payload: structuredClone(row.payload) });
    }
    return Promise.resolve(records);
  }

  insertItems(items: readonly StoredResponsesItem[], options: { readonly durable: boolean }): Promise<void> {
    for (const item of items) {
      const key = scopedKey(item.apiKeyId, item.id);
      const existing = this.items.get(key);
      if (existing) {
        if (options.durable) existing.durable = true;
        continue;
      }
      this.items.set(key, { row: cloneStoredResponsesItem(item), durable: options.durable });
    }
    return Promise.resolve();
  }

  fillPayloads(items: readonly StoredResponsesItem[], options: { readonly durable: boolean }): Promise<void> {
    for (const item of items) {
      if (item.payload === null) continue;
      const existing = this.items.get(scopedKey(item.apiKeyId, item.id));
      if (existing?.row.payload !== null) continue;
      existing.row = {
        ...existing.row,
        payload: structuredClone(item.payload),
        contentHash: item.contentHash,
        encryptedContentHash: item.encryptedContentHash,
        createdAt: item.createdAt,
        refreshedAt: Math.max(existing.row.refreshedAt, item.refreshedAt),
      };
      if (options.durable) existing.durable = true;
    }
    return Promise.resolve();
  }

  markDurable(apiKeyId: string | null, id: string): void {
    const existing = this.items.get(scopedKey(apiKeyId, id));
    if (existing) existing.durable = true;
  }

  refreshItems(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<void> {
    for (const id of new Set(ids)) {
      const existing = this.items.get(scopedKey(apiKeyId, id));
      if (existing && existing.row.refreshedAt < refreshedAt) {
        existing.row = { ...existing.row, refreshedAt };
      }
    }
    return Promise.resolve();
  }

  lookupSnapshot(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.snapshots.get(scopedKey(apiKeyId, id));
    return Promise.resolve(snapshot ? cloneStoredResponsesSnapshot(snapshot) : null);
  }

  insertSnapshot(snapshot: StoredResponsesSnapshot): Promise<void> {
    const key = scopedKey(snapshot.apiKeyId, snapshot.id);
    this.snapshots.set(key, cloneStoredResponsesSnapshot(snapshot));
    return Promise.resolve();
  }

  refreshSnapshot(apiKeyId: string | null, id: string, refreshedAt: number): Promise<void> {
    const key = scopedKey(apiKeyId, id);
    const snapshot = this.snapshots.get(key);
    if (snapshot && snapshot.refreshedAt < refreshedAt) {
      this.snapshots.set(key, { ...snapshot, refreshedAt });
    }
    return Promise.resolve();
  }
}

// For Messages/Chat/Gemini HTTP entries — reads for affinity, writes result item metadata,
// no snapshot writes, no user-controlled store flag.
export const createNonResponsesSourceStore = (apiKeyId: string | null): StatefulResponsesStore =>
  new LayeredStatefulResponsesStore({
    apiKeyId,
    reads: [new RepoStatefulResponsesBacking(getRepo)],
    itemWrites: [{ backing: new RepoStatefulResponsesBacking(getRepo), durable: true }],
    snapshotWrites: [],
    stageInputs: false,
  });

// For Responses HTTP entry — honors the user-supplied store=true/false.
export const createResponsesHttpStore = (apiKeyId: string | null, store: boolean | undefined): StatefulResponsesStore =>
  new LayeredStatefulResponsesStore({
    apiKeyId,
    reads: [new RepoStatefulResponsesBacking(getRepo)],
    itemWrites: [{ backing: new RepoStatefulResponsesBacking(getRepo), durable: true }],
    snapshotWrites: store === false ? [] : [{ backing: new RepoStatefulResponsesBacking(getRepo), durable: true }],
    stageInputs: store !== false,
    shouldStorePayload: store !== false,
  });

// For Responses WebSocket entry — session-scoped layered store.
//
// `store=false` on a WS message disables the durable backing for that turn but
// still records full items and snapshots in the session-scoped in-memory layer,
// so subsequent messages on the same socket can resolve `previous_response_id`
// against them. The session's lifetime bounds the data — nothing persists beyond
// the socket. `store=true` (or omitted) layers durable repo writes on top of the
// in-memory layer, so the turn is also addressable from later sessions.
//
// The session owns only the pair of backings that persist across turns; the
// per-turn `apiKeyId` is passed into `createStore` by the caller (which sources
// it from `ctx.apiKeyId`), keeping apiKeyId ownership on the ctx.
export const createResponsesWsSession = (): {
  createStore(apiKeyId: string | null, store: boolean | undefined): StatefulResponsesStore;
} => {
  const localBacking = new MemoryStatefulResponsesBacking();
  const repoBacking = new RepoStatefulResponsesBacking(getRepo);
  return {
    createStore(apiKeyId: string | null, store: boolean | undefined): StatefulResponsesStore {
      const localWrite = { backing: localBacking, durable: false };
      if (store === false) {
        return new LayeredStatefulResponsesStore({
          apiKeyId,
          reads: [localBacking, repoBacking],
          itemWrites: [localWrite],
          snapshotWrites: [localWrite],
          stageInputs: true,
        });
      }
      const repoWrite = { backing: repoBacking, durable: true };
      return new LayeredStatefulResponsesStore({
        apiKeyId,
        reads: [localBacking, repoBacking],
        itemWrites: [localWrite, repoWrite],
        snapshotWrites: [localWrite, repoWrite],
        stageInputs: true,
      });
    },
  };
};

const pushByHash = (target: Map<string, StoredResponsesItemMetadata[]>, hash: string, row: StoredResponsesItemMetadata): void => {
  const rows = target.get(hash) ?? [];
  if (!rows.some(existing => existing.id === row.id && existing.apiKeyId === row.apiKeyId)) {
    rows.push(row);
    rows.sort(compareItemsByFreshness);
  }
  target.set(hash, rows);
};

const isReplayableSnapshotMetadata = (row: StoredResponsesItemMetadata): boolean =>
  row.hasPayload || (row.upstreamId !== null && row.upstreamItemId !== null);
