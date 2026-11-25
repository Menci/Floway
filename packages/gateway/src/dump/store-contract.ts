import type { CommitDumpArchive, PipelineDumpMetadata } from './archive-metadata.ts';

export type WriteDumpArchive = (keyId: string, id: string, bytes: ReadableStream<Uint8Array>) => Promise<CommitDumpArchive>;

export interface DumpListOptions {
  before?: string;
  q?: string | undefined;
  failures?: boolean;
  limit: number;
}

export interface DumpStore {
  writeArchive: WriteDumpArchive;
  list(keyId: string, opts: DumpListOptions): Promise<PipelineDumpMetadata[]>;
  get(keyId: string, recordId: string): Promise<ReadableStream<Uint8Array> | null>;
  deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number>;
  findOldestCreatedAt(keyId: string): Promise<number | null>;
}
