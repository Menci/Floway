import type { DumpMetadata, DumpRecordId } from './types.ts';

export interface DumpListOptions {
  before?: DumpRecordId;
  q?: string;
  failures?: boolean;
  limit: number;
}

export interface DumpStore {
  createArtifactKey(keyId: string, startedAt: number, recordId: string): string;
  stageAndPutArtifact(
    keyId: string,
    recordId: string,
    artifactKey: string,
    ndjsonStream: ReadableStream<Uint8Array>,
  ): Promise<void>;
  commitRecord(keyId: string, record: { readonly meta: DumpMetadata; readonly artifactKey: string }): Promise<void>;
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;
  getMeta(keyId: string, recordId: DumpRecordId): Promise<DumpMetadata | null>;
  getArtifactStream(keyId: string, recordId: DumpRecordId): Promise<ReadableStream<Uint8Array> | null>;
  deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number>;
  findOldestCreatedAt(keyId: string): Promise<number | null>;
}
