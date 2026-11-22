import { ProviderModelsUnavailableError } from '@floway-dev/provider';

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

export const mergeForwardedUpstreamHeaders = (base: HeadersInit | undefined, upstream: Headers | undefined): Headers => {
  const merged = new Headers(base);
  if (upstream) {
    for (const [name, value] of upstream) {
      if (isForwardableUpstreamHeader(name)) merged.set(name, value);
    }
  }
  return merged;
};

const forwardedResponseHeaders = (upstream: Headers, defaultContentType: string | null): Headers => {
  const contentType = upstream.get('content-type') ?? defaultContentType;
  return mergeForwardedUpstreamHeaders(contentType === null ? undefined : { 'content-type': contentType }, upstream);
};

export const providerModelsUnavailableResponse = (error: unknown): Response | null => {
  if (!(error instanceof ProviderModelsUnavailableError) || !error.httpResponse) return null;
  const { status, headers, body } = error.httpResponse;
  return new Response(body, { status, headers: forwardedResponseHeaders(headers, null) });
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
  const headers = forwardedResponseHeaders(response.headers, defaultContentType);
  return new Response(body, { status: response.status, headers });
};
