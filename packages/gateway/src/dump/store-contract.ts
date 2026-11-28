import type { DumpMetadata, DumpRecordId, DumpWriteRecord, PreparedDumpRequestBody, StoredDumpRecord } from './types.ts';

// Per-API-key request dump storage contract: metadata in SQL, bodies in the
// FileStore. Request bytes are prepared before the terminal write; reads
// always rehydrate raw bytes for the control plane.

export interface DumpListOptions {
  before?: DumpRecordId;
  q?: string | undefined;
  failures?: boolean;
  limit: number;
}

export interface DumpStore {
  // Starts body preparation while the request is in flight. Implementations
  // may return identity bytes, but persistent stores compress here so the
  // accumulator can release the original request buffer before terminal IO.
  prepareRequestBody(body: Uint8Array): Promise<PreparedDumpRequestBody>;

  // Write body files BEFORE the metadata row so a partial failure leaves
  // orphan files (sweep-collectable), not orphan rows (broken records).
  put(keyId: string, record: DumpWriteRecord): Promise<void>;

  // Newest-first, paginated by ULID cursor. Reads enforce the API key's
  // current rolling retention even before queued physical deletion runs.
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;

  // The same newest-first page merged across every key in `keyIds`, for the
  // dashboard's all-keys log. Ids are global ULIDs, so one `before` cursor
  // pages the merged stream rather than each key separately.
  listAll(keyIds: readonly string[], opts: DumpListOptions): Promise<DumpMetadata[]>;

  get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null>;

  // Detail lookup for the merged log, where the record's key is not known
  // before the read. Returns null unless the record belongs to one of
  // `keyIds` and that key still has retention.
  getAny(keyIds: readonly string[], recordId: DumpRecordId): Promise<StoredDumpRecord | null>;

  deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number>;
  findOldestCreatedAt(keyId: string): Promise<number | null>;
}
