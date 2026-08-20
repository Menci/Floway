import type { DumpRecord, StoredDumpRecord } from './types.ts';

// Sole place the storage shape crosses into the wire shape. Called once, at the control-plane
// HTTP boundary, just before `c.json(...)`. A run's stream is decoded UTF-8-fatal rather than
// sniffed: the gateway wrote those bytes itself, so anything that fails to decode is a corrupted
// record and says so.
export const dumpRecordToWire = (record: StoredDumpRecord): DumpRecord => ({
  meta: record.meta,
  events: new TextDecoder('utf-8', { fatal: true }).decode(record.events),
});
