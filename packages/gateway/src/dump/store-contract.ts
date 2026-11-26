import type { DumpMetadata, DumpRecordId } from './types.ts';

export interface DumpListOptions {
  before?: DumpRecordId;
  q?: string | undefined;
  failures?: boolean;
  limit: number;
}

export interface DumpStore {
  // Persist the file before the index row so a failed insert leaves a collectible file.
  putArchive(keyId: string, meta: DumpMetadata, archive: Uint8Array): Promise<void>;

  getArchive(keyId: string, recordId: DumpRecordId): Promise<ReadableStream<Uint8Array> | null>;

  // Newest-first, paginated by ULID cursor. Reads enforce the API key's
  // current rolling retention even before queued physical deletion runs.
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;

  deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number>;
  findOldestCreatedAt(keyId: string): Promise<number | null>;
}
