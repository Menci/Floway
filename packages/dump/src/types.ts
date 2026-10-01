import type { z } from 'zod';

import type { dumpErrorSchema, dumpMetadataSchema, dumpUpstreamRefSchema } from './schemas.ts';
import type { ChannelBroker } from '@floway-dev/platform';

export type DumpRecordId = string;
export type DumpErrorMeta = z.infer<typeof dumpErrorSchema>;
export type DumpMetadata = z.infer<typeof dumpMetadataSchema>;
export type DumpUpstreamRef = z.infer<typeof dumpUpstreamRefSchema>;
export type DumpBroker = ChannelBroker<DumpMetadata>;

export interface StoredDumpRecord {
  readonly meta: DumpMetadata;
  readonly events: Uint8Array;
}

export interface DumpRecord {
  readonly meta: DumpMetadata;
  readonly events: string;
}

export interface DumpListOptions {
  before?: DumpRecordId;
  q?: string;
  failures?: boolean;
  limit: number;
}

export interface DumpStore {
  put(keyId: string, record: StoredDumpRecord): Promise<void>;
  list(keyId: string, options: DumpListOptions): Promise<DumpMetadata[]>;
  get(keyId: string, recordId: DumpRecordId): Promise<StoredDumpRecord | null>;
  deleteExpiredBatch(keyId: string, now: number, limit: number): Promise<number>;
  findOldestCreatedAt(keyId: string): Promise<number | null>;
}

export const DUMP_DISABLED_REASON = 'dump retention disabled';
