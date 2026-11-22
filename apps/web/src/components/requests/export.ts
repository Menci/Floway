import { isSensitiveHeader, REDACTED_HEADER_VALUE, redactHeaderValue } from './header-redact';
import type { DumpMetadata } from '@floway-dev/gateway/browser';
import type { EncodedDumpEvent } from '@floway-dev/pipeline/browser';

export interface ExportableDumpRecord {
  readonly meta: DumpMetadata;
  readonly events: readonly EncodedDumpEvent[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const redactStoredValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactStoredValue);
  if (!isRecord(value)) return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) redacted[key] = redactStoredValue(child);
  if (Array.isArray(value.headers)) {
    redacted.headers = value.headers.map(entry => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') return redactStoredValue(entry);
      if (typeof entry[1] === 'string' && isSensitiveHeader(entry[0])) {
        return [entry[0], entry[1] === REDACTED_HEADER_VALUE ? entry[1] : redactHeaderValue(entry[1])];
      }
      return [entry[0], redactStoredValue(entry[1])];
    });
  }
  return redacted;
};

const redactRecord = (record: ExportableDumpRecord): ExportableDumpRecord => ({
  meta: record.meta,
  events: record.events.map(event => {
    if (event.k === 'enter') return { ...event, facts: redactStoredValue(event.facts) as typeof event.facts };
    if (event.k === 'leave') return { ...event, outcome: redactStoredValue(event.outcome) as typeof event.outcome };
    return event;
  }),
});

const serializeRecord = (record: ExportableDumpRecord): string => JSON.stringify({ format: 'floway-request-dump', version: 2, record }, null, 2);

export const exportRecords = (records: readonly ExportableDumpRecord[], separate: boolean): Blob => {
  const safeRecords = records.map(redactRecord);
  if (!separate) return new Blob([JSON.stringify({ format: 'floway-request-dump', version: 2, records: safeRecords }, null, 2)], { type: 'application/json' });
  // POSIX ustar keeps each UTF-8 JSON record independently readable without a runtime dependency.
  // https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html#tag_20_92_13_06
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const record of safeRecords) {
    const data = encoder.encode(serializeRecord(record));
    const header = new Uint8Array(512);
    const write = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    const name = record.meta.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    write(0, `${name}.json`);
    write(100, '0000644\0');
    write(108, '0000000\0');
    write(116, '0000000\0');
    write(124, `${data.length.toString(8).padStart(11, '0')}\0`);
    write(136, `${Math.floor(record.meta.completedAt / 1000).toString(8).padStart(11, '0')}\0`);
    write(148, '        ');
    write(156, '0');
    write(257, 'ustar\0');
    write(263, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, data, new Uint8Array((512 - data.length % 512) % 512));
  }
  chunks.push(new Uint8Array(1024));
  return new Blob(chunks, { type: 'application/x-tar' });
};

export const downloadRecords = (records: readonly ExportableDumpRecord[], separate = false): void => {
  const url = URL.createObjectURL(exportRecords(records, separate));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `floway-requests-${records.length === 1 ? records[0]!.meta.id : new Date().toISOString().slice(0, 10)}.${separate ? 'tar' : 'json'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
