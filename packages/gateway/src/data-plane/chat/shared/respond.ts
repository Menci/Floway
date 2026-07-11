import type { Context } from 'hono';

import type { StreamCompletion } from './stream/sse.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import { hasTokenUsage } from '../../shared/telemetry/usage.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { plainResult } from '@floway-dev/provider';
import type { EventResultMetadata, ExecuteResult, PlainResult } from '@floway-dev/provider';

// Emits a measurement endpoint's already-shaped body verbatim. The endpoint's
// `attempt` owns all shaping — the success body and any source-specific error
// envelope — so every source's `respond` renders a plain result identically.
export const plainResultToResponse = (result: PlainResult): Response =>
  new Response(result.body.slice().buffer, { status: result.status, headers: result.headers });

// Used by count_tokens endpoints that either pass through the upstream body
// or wrap an already-built error/success Response.
export const plainResultFromResponse = async (response: Response, upstream?: string): Promise<PlainResult> =>
  plainResult(
    response.status,
    new Headers({ 'content-type': response.headers.get('content-type') ?? 'application/json' }),
    new Uint8Array(await response.arrayBuffer()),
    upstream,
  );

// Per-stream observation accumulated by each source's frame observer and read
// back when the response settles: did the stream fail, did it reach its
// terminal frame, and the last frame-level usage worth billing.
export class SourceStreamState {
  failed = false;
  completed = false;
  usage: TokenUsage | null = null;

  // Only a frame carrying real (non-zero) usage overwrites the running figure,
  // so an empty trailing frame can't wipe a good count.
  rememberUsage(usage: TokenUsage | null): void {
    if (usage && hasTokenUsage(usage)) this.usage = usage;
  }

  failedAfter(completion: StreamCompletion): boolean {
    return completion === 'error' || this.failed || (completion === 'cancel' && !this.completed);
  }
}

export const eventResultMetadata = async <TEvent>(result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ?? {
    modelIdentity: result.modelIdentity,
    ...(result.performance ? { performance: result.performance } : {}),
  });

// Upstream response headers we propagate verbatim to the downstream client.
// A blocklist (not an allowlist): operators want to see what the upstream
// actually sent — vendor traces (`request-id`, `cf-ray`), plan-billing state
// (`anthropic-ratelimit-*`, which the official `claude-code` CLI's `/status`
// indicator reads), and any future `x-*` an upstream introduces. We only
// strip what we MUST or what would actively break downstream framing:
//
//   - hop-by-hop headers (RFC 7230 §6.1) MUST NOT be forwarded by
//     intermediaries.
//   - `content-length` / `content-encoding` / `content-type` are managed by
//     the streaming layer: it rewrites the body (SSE re-framing, optional
//     decompression + re-encode) so upstream's values would mis-frame the
//     downstream response. The SSE writer sets its own `text/event-stream`;
//     non-SSE pass-throughs hand content-type back via their own path.
//   - `set-cookie` / `set-cookie2`: we didn't issue these and propagating
//     upstream session bindings is a footgun.
const BLOCKED_UPSTREAM_HEADERS: ReadonlySet<string> = new Set([
  // hop-by-hop (RFC 7230 §6.1)
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // body framing — owned by the streaming layer
  'content-length',
  'content-encoding',
  'content-type',
  // cookies
  'set-cookie',
  'set-cookie2',
]);

export const isForwardableUpstreamHeader = (name: string): boolean =>
  !BLOCKED_UPSTREAM_HEADERS.has(name.toLowerCase());

// Stages forwardable upstream headers onto the Hono context so the next
// `c.newResponse` (or `streamSSE`'s internal `c.newResponse`) emits them on
// the response. Hono's `c.header()` is the only knob that survives a later
// `c.json` or `streamSSE` call without being overwritten. Safe to call with
// `undefined` so callers can pass `result.headers` directly.
export const forwardUpstreamHeaders = (c: Context, headers: Headers | undefined): void => {
  if (!headers) return;
  for (const [name, value] of headers) {
    if (isForwardableUpstreamHeader(name)) c.header(name, value);
  }
};

// Used by non-streaming JSON responses where the response is built directly
// (`Response.json(...)`) instead of through Hono's `c`.
export const mergeForwardedUpstreamHeaders = (base: HeadersInit | undefined, upstream: Headers | undefined): HeadersInit => {
  const merged = new Headers(base);
  if (upstream) {
    for (const [name, value] of upstream) {
      if (isForwardableUpstreamHeader(name)) merged.set(name, value);
    }
  }
  return merged;
};
