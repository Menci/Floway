import { isSensitiveHeader, redactHeaderValue } from './header-redact';
import type { DumpRecord } from '@floway-dev/gateway/dump-types';

// The dump API serves headers verbatim so the dashboard's reveal affordance
// keeps working, but an exported file leaves the operator's machine, so every
// credential header is masked to its redacted form before serialization.
const redactHeaders = (headers: Array<[string, string]>): Array<[string, string]> =>
  headers.map(([name, value]) => isSensitiveHeader(name) ? [name, redactHeaderValue(value)] as [string, string] : [name, value]);

const redactRecord = (record: DumpRecord): DumpRecord => {
  const capture = record.capture === undefined ? undefined : {
    ...record.capture,
    exchanges: record.capture.exchanges.map(exchange => ({
      ...exchange,
      request: { ...exchange.request, headers: redactHeaders(exchange.request.headers) },
      response: exchange.response === null ? null : { ...exchange.response, headers: redactHeaders(exchange.response.headers) },
    })),
  };
  return {
    ...record,
    request: { ...record.request, headers: redactHeaders(record.request.headers) },
    response: {
      ...record.response,
      headers: redactHeaders(record.response.headers),
      ...(record.response.upstream !== undefined ? { upstream: { ...record.response.upstream, headers: redactHeaders(record.response.upstream.headers) } } : {}),
    },
    ...(capture === undefined ? {} : { capture }),
  };
};

const serializeRecord = (record: DumpRecord): string => JSON.stringify({ format: 'floway-request-dump', version: 1, record: redactRecord(record) }, null, 2);

export const exportRecords = (records: DumpRecord[], separate: boolean): Blob => {
  if (!separate) return new Blob([JSON.stringify({ format: 'floway-request-dump', version: 1, records: records.map(redactRecord) }, null, 2)], { type: 'application/json' });
  // POSIX ustar keeps each UTF-8 JSON record independently readable without a runtime dependency.
  // https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html#tag_20_92_13_06
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const record of records) {
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

export const downloadRecords = (records: DumpRecord[], separate = false): void => {
  const url = URL.createObjectURL(exportRecords(records, separate));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `floway-requests-${records.length === 1 ? records[0]!.meta.id : new Date().toISOString().slice(0, 10)}.${separate ? 'tar' : 'json'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
