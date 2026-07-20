import type { Context } from 'hono';

// Upstream response headers are propagated through a blocklist so vendor
// traces, quota state, and future end-to-end metadata remain visible. Only
// fields that intermediaries must strip, that would misdescribe a rewritten
// body, or that would leak an upstream session are removed.
const BLOCKED_UPSTREAM_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
  'content-type',
  'set-cookie',
  'set-cookie2',
]);

export const isForwardableUpstreamHeader = (name: string): boolean =>
  !BLOCKED_UPSTREAM_HEADERS.has(name.toLowerCase());

// Stage headers on Hono before a later c.json()/streamSSE() constructs the
// response. Content type remains owned by that response constructor.
export const forwardUpstreamHeaders = (c: Context, headers: Headers | undefined): void => {
  if (!headers) return;
  for (const [name, value] of headers) {
    if (isForwardableUpstreamHeader(name)) c.header(name, value);
  }
};

export const mergeForwardedUpstreamHeaders = (base: HeadersInit | undefined, upstream: Headers | undefined): Headers => {
  const merged = new Headers(base);
  if (upstream) {
    for (const [name, value] of upstream) {
      if (isForwardableUpstreamHeader(name)) merged.set(name, value);
    }
  }
  return merged;
};

export interface ForwardUpstreamResponseOptions {
  readonly body?: BodyInit | null;
  readonly defaultContentType?: string | null;
}

// Forward a raw or replaced body with every safe upstream header. JSON is the
// default for existing passthrough APIs; callers serving untyped raw bodies can
// explicitly pass defaultContentType: null.
export const forwardUpstreamResponse = (
  response: Response,
  options: ForwardUpstreamResponseOptions = {},
): Response => {
  const { body = response.body, defaultContentType = 'application/json' } = options;
  const headers = new Headers();
  const contentType = response.headers.get('content-type') ?? defaultContentType;
  if (contentType !== null) headers.set('content-type', contentType);
  for (const [name, value] of response.headers) {
    if (isForwardableUpstreamHeader(name)) headers.set(name, value);
  }
  return new Response(body, { status: response.status, headers });
};
