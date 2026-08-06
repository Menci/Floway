import type { DumpMetadata, DumpRecordId, DumpWriteRecord, PreparedDumpRequestBody, StoredDumpRecord } from './types.ts';

// Per-API-key request dump storage contract: metadata in SQL, bodies in the
// FileStore. Request bytes are prepared before the terminal write; reads
// always rehydrate raw bytes for the control plane.

export interface DumpListOptions {
  before?: DumpRecordId;
  limit: number;
}

export interface DumpRequestBodyPreparationOptions {
  readonly compression: 'adaptive' | 'identity';
}

export interface DumpStore {
  // Starts bounded body preparation while the request is in flight. Multipart
  // owners choose identity to avoid another binary-body representation;
  // adaptive preparation keeps gzip only when it actually reduces storage.
  prepareRequestBody(body: Uint8Array, options: DumpRequestBodyPreparationOptions): Promise<PreparedDumpRequestBody>;

  // Write body files BEFORE the metadata row so a partial failure leaves
  // orphan files (sweep-collectable), not orphan rows (broken records).
  put(keyId: string, record: DumpWriteRecord): Promise<void>;

  // Newest-first, paginated by ULID cursor. Reads enforce the API key's
  // current rolling retention even before queued physical deletion runs.
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;

  get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null>;

  deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number>;
  findOldestCreatedAt(keyId: string): Promise<number | null>;
}
