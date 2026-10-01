import type { DumpMetadata, DumpRecordId, StoredDumpRecord } from './types.ts';

// Per-API-key run storage: metadata in SQL and compressed NDJSON in the
// FileStore. Completed writes stage their file before publishing the row;
// detail reads rehydrate the event bytes for the control plane.

export interface DumpListOptions {
  before?: DumpRecordId;
  q?: string;
  failures?: boolean;
  limit: number;
}

export interface DumpStore {
  // Store the completed event artifact before publishing metadata. Failed writes
  // leave staged files collectible by the retention sweep.
  put(keyId: string, record: StoredDumpRecord): Promise<void>;

  // Newest-first, paginated by ULID cursor. Reads enforce the API key's
  // current rolling retention even before queued physical deletion runs.
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;

  get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null>;

  deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number>;
  findOldestCreatedAt(keyId: string): Promise<number | null>;
}
