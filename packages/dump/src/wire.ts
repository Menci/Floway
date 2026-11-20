import { redactRunCredentials } from './redact.ts';
import type { DumpRecord, StoredDumpRecord } from './types.ts';

export const dumpRecordToWire = (record: StoredDumpRecord): DumpRecord => ({
  meta: record.meta,
  events: redactRunCredentials(new TextDecoder('utf-8', { fatal: true }).decode(record.events)),
});
