import type { DumpMetadata, DumpRecordId, DumpWriteRecord, PreparedDumpRequestBody, StoredDumpRecord } from './types.ts';

// Per-API-key request dump storage contract: metadata in SQL, bodies in the
// FileProvider. Request bytes are prepared before the terminal write; reads
// always rehydrate raw bytes for the control plane.

export interface DumpListOptions {
  before?: DumpRecordId;
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

  // Newest-first, paginated by ULID cursor. Retention is enforced by the
  // cron sweep, not here, so the dashboard may briefly show records that
  // have aged past retention until the next sweep window drops them.
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;

  get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null>;

  // Drop every record (rows + files) for this key. Idempotent.
  purgeAll(keyId: string): Promise<void>;

  // Drop records older than `retentionSeconds` for this key. Idempotent.
  purgeExpired(keyId: string, retentionSeconds: number): Promise<void>;
}
