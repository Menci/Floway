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

export const providerModelsUnavailableResponse = (error: unknown): Response | null => {
  if (!(error instanceof ProviderModelsUnavailableError) || !error.httpResponse) return null;
  const { status, headers, body } = error.httpResponse;
  const forwarded = [...headers].filter(([name]) => name === 'content-type' || isForwardableUpstreamHeader(name));
  return new Response(body, { status, headers: forwarded });
};
