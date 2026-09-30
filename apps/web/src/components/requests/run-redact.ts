import { isSensitiveHeader, redactHeaderValue } from './header-redact';
import type { DumpEvent } from '@floway-dev/gateway/dump-types';

// Header values can be shared string nodes. Redacting only the tuple would
// leave the original credential in the object event that defined that node.
export const redactRunHeaders = (ndjson: string): string => {
  const events = ndjson.split('\n').filter(Boolean).map(line => JSON.parse(line) as DumpEvent);
  const nodes = new Map<number, { values: unknown[]; index: number }>();
  for (const event of events) {
    if (event.type !== 'object') continue;
    for (let index = 0; index < event.nodes.length; index++) {
      nodes.set(event.fromObjectId + index, { values: event.nodes as unknown[], index });
    }
  }
  const reference = (value: unknown): number | null =>
    typeof value === 'object' && value !== null && '$' in value && typeof value.$ === 'number' ? value.$ : null;
  const node = (id: number) => {
    const slot = nodes.get(id);
    if (slot === undefined) throw new Error(`Run export references missing object ${id}`);
    return slot;
  };
  const resolve = (value: unknown): unknown => {
    const id = reference(value);
    if (id === null) return value;
    const slot = node(id);
    return slot.values[slot.index];
  };
  const redactedPairs = new Set<unknown[]>();
  const redactedStrings = new Set<number>();
  for (const event of events) {
    if (event.type !== 'stage.entered' && event.type !== 'stage.leaved') continue;
    for (const [key, value] of Object.entries(event.facts ?? {})) {
      if (!key.endsWith('.http.headers')) continue;
      const headers = resolve(value);
      if (!Array.isArray(headers)) throw new Error(`Run export has invalid headers at ${key}`);
      for (const entry of headers) {
        const pair = resolve(entry);
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`Run export has invalid header at ${key}`);
        if (redactedPairs.has(pair)) continue;
        const name = resolve(pair[0]);
        if (typeof name !== 'string') throw new Error(`Run export has invalid header name at ${key}`);
        if (!isSensitiveHeader(name)) continue;
        redactedPairs.add(pair);
        const id = reference(pair[1]);
        if (id !== null && redactedStrings.has(id)) continue;
        const secret = resolve(pair[1]);
        if (typeof secret !== 'string') {
          if (typeof secret === 'object' && secret !== null && '$secret' in secret) continue;
          throw new Error(`Run export has invalid header value at ${key}`);
        }
        const redacted = redactHeaderValue(secret);
        if (id === null) pair[1] = redacted;
        else {
          const slot = node(id);
          slot.values[slot.index] = redacted;
          redactedStrings.add(id);
        }
      }
    }
  }
  return events.map(event => `${JSON.stringify(event)}\n`).join('');
};
