import type { DumpRecord, StoredDumpRecord } from './types.ts';

export const dumpRecordToWire = (record: StoredDumpRecord): DumpRecord => ({
  meta: record.meta,
  events: new TextDecoder('utf-8', { fatal: true }).decode(record.events),
});
