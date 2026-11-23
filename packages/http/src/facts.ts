import { secret, type Bytes, type ErrorSnapshot, type ManagedStream, type Secret } from '@floway-dev/pipeline';

export type HeaderEntry = readonly [name: string, value: string | Secret<string>];

export interface HttpUrl {
  readonly origin: string;
  readonly pathname: string;
  readonly query?: readonly (readonly [name: string, value: string | Secret<string>])[];
}

export type HttpRequestBody =
  | Bytes
  | ManagedStream<Bytes>
  | { readonly kind: 'upload-error'; readonly error: ErrorSnapshot }
  | null;

export interface HttpRequestFacts {
  readonly method: string;
  readonly url: HttpUrl;
  readonly headers: readonly HeaderEntry[];
  readonly body: HttpRequestBody;
}

export interface TransportFailure {
  readonly type: 'transport-error';
  readonly error: ErrorSnapshot;
}

export const isTransportFailure = (value: unknown): value is TransportFailure =>
  typeof value === 'object' && value !== null && (value as { readonly type?: unknown }).type === 'transport-error';

export type HttpResponseBodyChunk = Bytes | TransportFailure;

export interface HttpResponseFacts<Chunk = HttpResponseBodyChunk> {
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body: ManagedStream<Chunk> | Bytes | null;
  readonly timing: { readonly startedAt: number; readonly headersAt: number };
  readonly exchange?: 'upstream';
  readonly transportError?: ErrorSnapshot;
}

export const httpUrl = (url: string | URL, sensitiveQueryNames: readonly string[] = []): HttpUrl => {
  const { origin, pathname, searchParams, username, password } = typeof url === 'string' ? new URL(url) : url;
  if (username || password) throw new TypeError('HTTP fact URLs cannot contain credentials');
  const query = Array.from(searchParams, ([name, value]) => [name, sensitiveQueryNames.includes(name) ? secret(value) : value] as const);
  return { origin, pathname, ...(query.length === 0 ? {} : { query }) };
};

const sensitiveHeaderNames = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  'www-authenticate',
  'proxy-authenticate',
]);

export const wrapSensitiveHeaderEntries = (entries: Iterable<HeaderEntry>): readonly HeaderEntry[] =>
  Array.from(entries, ([name, value]) => [name, typeof value === 'string' && sensitiveHeaderNames.has(name.toLowerCase()) ? secret(value) : value]);
