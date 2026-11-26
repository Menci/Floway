import { isSensitiveHeader, REDACTED_HEADER_VALUE, redactHeaderValue } from './header-redact';

export interface ArchiveExport {
  id: string;
  archive: string;
}

interface ArchiveEvent {
  type: string;
  facts?: { $: number };
}

interface ObjectBatch extends ArchiveEvent {
  type: 'object';
  fromObjectId: number;
  nodes: unknown[];
}

const rewriteObjectBatch = (line: string, updates: ReadonlyMap<number, string>): string => {
  const marker = '"nodes":[';
  const nodes = line.indexOf(marker);
  if (nodes < 0) throw new Error('Expected encoded request archive nodes');
  let start = nodes + marker.length;
  const output = [line.slice(0, start)];
  let index = 0;
  let depth = 0;
  let quoted = false;
  for (let cursor = start; cursor < line.length; cursor++) {
    const character = line[cursor];
    if (quoted) {
      if (character === '\\') cursor++;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
    } else if (depth === 0 && (character === ',' || character === ']')) {
      output.push(updates.get(index++) ?? line.slice(start, cursor));
      if (character === ']') return [...output, line.slice(cursor)].join('');
      output.push(character);
      start = cursor + 1;
    } else if (character === '[' || character === '{') {
      depth++;
    } else if (character === ']' || character === '}') {
      depth--;
    }
  }
  throw new Error('Unterminated request archive nodes');
};

const redactArchive = (archive: string): string => {
  const lines = archive.trimEnd().split('\n');
  const events = lines.map(line => JSON.parse(line) as ArchiveEvent);
  const nodes = new Map<number, { node: unknown; batchIndex: number; index: number }>();
  for (const [batchIndex, event] of events.entries()) {
    if (event.type !== 'object') continue;
    const batch = event as ObjectBatch;
    for (const [index, node] of batch.nodes.entries()) nodes.set(batch.fromObjectId + index, { node, batchIndex, index });
  }
  const lookup = (ref: unknown) =>
    typeof ref === 'object' && ref !== null && '$' in ref && typeof ref.$ === 'number' ? nodes.get(ref.$) : undefined;
  const rewritten = new Map<number, Map<number, string>>();
  for (const event of events) {
    if (!event.facts) continue;
    const facts = lookup(event.facts)?.node as Record<string, unknown> | undefined;
    if (!facts) throw new Error('Request archive contains a missing facts object');
    for (const key of ['request.http', 'response.http']) {
      const http = lookup(facts[key])?.node as { headers?: unknown } | undefined;
      if (!http) continue;
      const headers = lookup(http.headers)?.node;
      if (!Array.isArray(headers)) throw new Error('Request archive contains a missing header list');
      for (const ref of headers) {
        const pair = lookup(ref);
        if (!pair || !Array.isArray(pair.node)) throw new Error('Request archive contains a missing header pair');
        const [name, value] = pair.node as unknown[];
        if (typeof name !== 'string' || typeof value !== 'string' || !isSensitiveHeader(name) || value === REDACTED_HEADER_VALUE) continue;
        const updates = rewritten.get(pair.batchIndex) ?? new Map<number, string>();
        updates.set(pair.index, JSON.stringify([name, redactHeaderValue(value)]));
        rewritten.set(pair.batchIndex, updates);
      }
    }
  }
  return `${lines.map((line, index) => {
    const updates = rewritten.get(index);
    return updates === undefined ? line : rewriteObjectBatch(line, updates);
  }).join('\n')}\n`;
};

export const exportRecords = (records: ArchiveExport[], separate: boolean): Blob => {
  const redacted = records.map(record => ({ ...record, archive: redactArchive(record.archive) }));
  if (!separate) return new Blob([JSON.stringify({ format: 'floway-request-dump', version: 2, records: redacted }, null, 2)], { type: 'application/json' });
  // POSIX ustar keeps each NDJSON archive independently readable.
  // https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html#tag_20_92_13_06
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (const { id, archive } of redacted) {
    const data = encoder.encode(archive);
    const header = new Uint8Array(512);
    const write = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    const name = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    write(0, `${name}.ndjson`);
    write(100, '0000644\0');
    write(108, '0000000\0');
    write(116, '0000000\0');
    write(124, `${data.length.toString(8).padStart(11, '0')}\0`);
    write(136, '00000000000\0');
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

export const downloadRecords = (records: ArchiveExport[], separate = false): void => {
  const url = URL.createObjectURL(exportRecords(records, separate));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `floway-requests-${records.length === 1 ? records[0]!.id : new Date().toISOString().slice(0, 10)}.${separate ? 'tar' : 'json'}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
