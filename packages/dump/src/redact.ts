import type { DumpEvent, Event } from '@floway-dev/pipeline';

const SENSITIVE_HEADERS = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x-goog-api-key',
]);

export const REDACTED_HEADER_VALUE = '[redacted]';

export const isSensitiveHeader = (name: string): boolean => SENSITIVE_HEADERS.has(name.toLowerCase());

// The owner of a key may read the dump, but the upstream credentials in it
// belong to an operator who granted Model.Use, not to that key owner.
export const redactSensitiveHeaders = (headers: ReadonlyArray<readonly [string, string]>): Array<[string, string]> =>
  headers.map(([name, value]) => [name, isSensitiveHeader(name) ? REDACTED_HEADER_VALUE : value]);

/** Header lists a run records about its upstream exchanges. The client's own request headers
 *  are the key owner's, so `ingress.http.headers` keeps them. */
const upstreamHeaderLists = (key: string, value: unknown, resolve: (value: unknown) => unknown): unknown[] => {
  if (key === 'ingress.http.headers') return [];
  if (key.endsWith('.http.headers')) return [value];
  if (key !== 'response.http.exchange') return [];
  const exchange = resolve(value);
  if (typeof exchange !== 'object' || exchange === null || !('headers' in exchange)) return [];
  return [exchange.headers];
};

/**
 * The run's recorded events with every upstream credential header replaced by its redacted
 * form. A value a stage marked secret is already recorded redacted; this covers the plain
 * strings an upstream sent back or an operator configured as a fixed header. Header strings are
 * interned, so a value is rewritten in the object event that defined it — rewriting the tuple
 * alone would leave the credential in that node.
 */
export const redactRunCredentials = (ndjson: string): string => {
  const events = ndjson.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as DumpEvent);
  const nodes = new Map<number, { values: unknown[]; index: number }>();
  for (const event of events) {
    if (event.type !== 'object') continue;
    event.nodes.forEach((_, index) => nodes.set(event.fromObjectId + index, { values: event.nodes as unknown[], index }));
  }
  const reference = (value: unknown): number | null =>
    typeof value === 'object' && value !== null && '$' in value && typeof value.$ === 'number' ? value.$ : null;
  const slot = (id: number) => {
    const found = nodes.get(id);
    if (found === undefined) throw new Error(`Run events reference missing object ${id}`);
    return found;
  };
  const resolve = (value: unknown): unknown => {
    const id = reference(value);
    if (id === null) return value;
    const found = slot(id);
    return found.values[found.index];
  };
  const redactValue = (pair: unknown[]): void => {
    const id = reference(pair[1]);
    if (id === null) {
      if (typeof pair[1] === 'string') pair[1] = REDACTED_HEADER_VALUE;
      return;
    }
    const found = slot(id);
    if (typeof found.values[found.index] === 'string') found.values[found.index] = REDACTED_HEADER_VALUE;
  };
  for (const event of events) {
    if (event.type !== 'stage.entered' && event.type !== 'stage.leaved') continue;
    for (const [key, value] of Object.entries(event.facts ?? {})) {
      for (const list of upstreamHeaderLists(key, value, resolve)) {
        const headers = resolve(list);
        if (!Array.isArray(headers)) throw new Error(`Run events record invalid headers at ${key}`);
        for (const entry of headers) {
          const pair = resolve(entry);
          if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`Run events record an invalid header at ${key}`);
          const name = resolve(pair[0]);
          if (typeof name !== 'string') throw new Error(`Run events record an invalid header name at ${key}`);
          if (isSensitiveHeader(name)) redactValue(pair);
        }
      }
    }
  }
  return events.map(event => `${JSON.stringify(event)}\n`).join('');
};

/** Redact before encoding so neither durable nor live object batches contain upstream
 *  credential strings. Cached replacements preserve sharing across observations. */
export const createRunEventRedactor = (): ((event: Event) => Event) => {
  type Headers = readonly (readonly [string, unknown])[];
  const headerCache = new WeakMap<Headers, Headers>();
  const exchangeCache = new WeakMap<object, object>();
  const redactHeaders = (headers: Headers): Headers => {
    const cached = headerCache.get(headers);
    if (cached !== undefined) return cached;
    let changed = false;
    const entries = headers.map(entry => {
      const [name, value] = entry;
      if (!isSensitiveHeader(name) || typeof value !== 'string' || value === REDACTED_HEADER_VALUE) return entry;
      changed = true;
      return [name, REDACTED_HEADER_VALUE] as const;
    });
    const redacted = changed ? entries : headers;
    headerCache.set(headers, redacted);
    return redacted;
  };
  const redactFact = (key: string, value: unknown): unknown => {
    if (key === 'ingress.http.headers') return value;
    if (key.endsWith('.http.headers')) return redactHeaders(value as Headers);
    if (key !== 'response.http.exchange') return value;
    const exchange = value as object;
    if (!('headers' in exchange)) return value;
    const cached = exchangeCache.get(exchange);
    if (cached !== undefined) return cached;
    const headers = redactHeaders(exchange.headers as Headers);
    const redacted = headers === exchange.headers ? exchange : { ...exchange, headers };
    exchangeCache.set(exchange, redacted);
    return redacted;
  };
  return event => {
    if (event.type !== 'stage.entered' && event.type !== 'stage.leaved') return event;
    let changed = false;
    const entries = Object.entries(event.facts).map(([key, value]) => {
      const redacted = redactFact(key, value);
      changed ||= redacted !== value;
      return [key, redacted];
    });
    return changed ? { ...event, facts: Object.fromEntries(entries) } : event;
  };
};
