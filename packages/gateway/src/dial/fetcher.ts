import { DIRECT_PROXY_ID, entryMatchesColo } from '../repo/proxy-fallback-list.ts';
import type { Repo } from '../repo/types.ts';
import type { HttpRequest } from '@floway-dev/http';
import { normalizeDialHost } from '@floway-dev/platform';
import type { Fetcher, ProxyFallbackEntry } from '@floway-dev/provider';
import { isAbortError } from '@floway-dev/provider';
import { ProxyDialError, type ProxyConfig, type ProxyRequestTarget, type RunProxiedRequestOptions, type SocketDial } from '@floway-dev/proxy';

// Pairs the parsed wire config with an optional per-proxy dial deadline so
// a slow but real proxy can be granted more time without raising the bar
// for the whole gateway.
export interface ProxyEntry {
  config: ProxyConfig;
  /** ms; null means "use the dialer's default". */
  dialTimeoutMs: number | null;
}

interface CreateFetcherInput {
  repo: Pick<Repo, 'proxyBackoffs'>;
  upstreamId: string;
  fallbackList: ProxyFallbackEntry[];
  proxyById: Map<string, ProxyEntry>;
  // Location tag the request landed in, used to apply each entry's optional
  // `colos` whitelist via `entryMatchesColo`. See `getCurrentColo`.
  currentColo: string;
  // Injected so the fetcher stays runtime-agnostic — the composition root
  // chooses the concrete dial/fetch implementations.
  runProxied: (
    config: ProxyConfig,
    target: ProxyRequestTarget,
    request: HttpRequest,
    options: RunProxiedRequestOptions,
  ) => Promise<Response>;
  // Per-request indirection for the 'direct' sentinel.
  runDirect: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Platform-injected raw TCP dial primitive, threaded into runProxied.
   * Lazily evaluated — only invoked when a non-direct fallback entry is
   * actually attempted, so direct-only call sites can run without an
   * installed SocketDial impl.
   */
  socketDial: () => SocketDial;
}

/**
 * Buffered request shape extracted from a Fetcher call. Splits the
 * transport target (host/port/tls/sni) from the HTTP-shaped request
 * (method/path/headers/body) so the dial layer and request-shaping layer
 * each receive only what they need.
 */
interface ProxiedRequest {
  target: ProxyRequestTarget;
  request: HttpRequest;
}

// Two-pass dial strategy. First pass walks the fallback list skipping any
// entry whose (proxy, upstream) backoff row is still active, so a flaky
// proxy gets shed in steady state. The second pass walks the entries that
// the first pass skipped (i.e. the backed-off ones) — that's how we both
// kick the recovery schedule and keep serving when literally every proxy
// is in cooldown. Entries that already failed on pass 1 are NOT retried
// in pass 2; doing so would double the backoff fail-count for every real
// failure and warp the geometric schedule.
//
// Body buffering is deferred until a non-`direct` proxy actually needs it;
// the direct-only fast path passes `init` straight to runtime `fetch`,
// which is how non-buffered shapes like FormData stay supported.
//
// Each per-attempt call is wrapped with `recordUpstreamLatency` when one is
// supplied. The recorder's "last wrap wins" semantics keep only the
// successful attempt's measurement; failed attempts whose promises reject
// also wrap (and clobber `last`), but only a successful attempt returns —
// and the next attempt's wrap immediately overwrites the prior duration on
// settle. The all-fail tail throws without anyone reading the duration.
export const createFetcher = (input: CreateFetcherInput): Fetcher => {
  // Colo filter precedes the implicit-['direct'] collapse so a fully-excluded
  // list behaves like an empty list and gets the direct fallback, rather than
  // throwing because pass 1 had no candidates.
  const matched = input.fallbackList.filter(entry => entryMatchesColo(entry, input.currentColo));
  const list = matched.length > 0 ? matched.map(entry => entry.id) : [DIRECT_PROXY_ID];
  // If `direct` precedes any non-direct entry, runtime fetch may take
  // ownership of `init.body` and consume its underlying stream/Blob.
  // Buffer the body up-front so a runtime that re-streams a Blob can't
  // strand a later proxy attempt with empty bytes. The fast path
  // (direct-only list) keeps the runtime's native body handling intact —
  // FormData, Blob, etc. don't need to be buffered.
  const hasNonDirect = list.some(id => id !== DIRECT_PROXY_ID);
  const directBeforeProxy = hasNonDirect && list.includes(DIRECT_PROXY_ID) && list.indexOf(DIRECT_PROXY_ID) < list.length - 1;
  return async (url, init, recordUpstreamLatency) => {
    // Reject streaming bodies upfront whenever any non-direct entry is in
    // play. The two-pass dial can replay a request and a stream is
    // single-shot; for a list like ['a','direct'] where 'a' is in active
    // backoff, pass 1 would consume the stream via the runtime fetch and
    // strand pass 2 with empty bytes.
    if (hasNonDirect && init.body instanceof ReadableStream) {
      throw new Error('streaming request bodies are not supported through proxies — buffer before calling');
    }
    let proxied: ProxiedRequest | undefined;
    let effectiveInit = init;
    if (directBeforeProxy) {
      // Pre-build the proxied request so the same buffered bytes feed both
      // the direct path (via a synthesised init) and any proxy retry.
      proxied = await buildProxiedRequest(url, init);
      effectiveInit = rebuildInitFromProxied(init, proxied);
    }
    const proxiedFor = async (): Promise<ProxiedRequest> => {
      proxied ??= await buildProxiedRequest(url, effectiveInit);
      return proxied;
    };
    const errors: unknown[] = [];

    const active = await input.repo.proxyBackoffs.listForUpstream(input.upstreamId);
    const now = Math.floor(Date.now() / 1000);
    const skip = new Set(active.filter(b => b.expiresAt > now).map(b => b.proxyId));

    // Track which entries have already been attempted in this call so the
    // second pass only retries the ones we actively skipped. Without this,
    // a single dial failure would record TWO recordDialFailure calls — the
    // backoff schedule advertised in proxy-backoffs would double-step on
    // every real failure.
    const triedThisCall = new Set<string>();
    for (const id of list) {
      if (skip.has(id)) continue;
      triedThisCall.add(id);
      const result = await tryOne(id, input, proxiedFor, url, effectiveInit, errors, recordUpstreamLatency);
      if (result) return result;
    }

    for (const id of list) {
      if (triedThisCall.has(id)) continue;
      const result = await tryOne(id, input, proxiedFor, url, effectiveInit, errors, recordUpstreamLatency);
      if (result) return result;
    }

    // A single fallback entry that failed once still produces just one
    // ProxyDialError in `errors` — surface it directly so callers don't see
    // a meaningless AggregateError wrapper.
    if (errors.length === 1) {
      throw errors[0];
    }
    throw new AggregateError(errors, 'all proxies failed at the dial layer');
  };
};

const rebuildInitFromProxied = (original: RequestInit, proxied: ProxiedRequest): RequestInit => {
  const headers = new Headers(original.headers);
  const targetCt = proxied.request.headers['content-type'];
  if (targetCt !== undefined && !headers.has('content-type')) {
    headers.set('content-type', targetCt);
  }
  // Copy into a freshly-allocated ArrayBuffer-backed Uint8Array so the
  // BodyInit slot accepts it under TypeScript's stricter typing — and so
  // the buffer we hand to runtime fetch never aliases a backing buffer
  // that's also referenced elsewhere.
  let body: Uint8Array<ArrayBuffer> | null = null;
  if (proxied.request.body) {
    const owned = new Uint8Array(proxied.request.body.byteLength);
    owned.set(proxied.request.body);
    body = owned;
  }
  return {
    ...original,
    headers,
    body,
  };
};

const tryOne = async (
  id: string,
  input: CreateFetcherInput,
  proxiedFor: () => Promise<ProxiedRequest>,
  url: string,
  init: RequestInit,
  errors: unknown[],
  recordUpstreamLatency: (<T>(promise: Promise<T>) => Promise<T>) | undefined,
): Promise<Response | null> => {
  const wrap = recordUpstreamLatency ?? (<T>(p: Promise<T>) => p);
  try {
    if (id === DIRECT_PROXY_ID) {
      // Direct egress is the runtime's fetch — it never raises ProxyDialError,
      // so we don't touch the backoff table for this entry.
      return await wrap(input.runDirect(url, init));
    }
    const config = input.proxyById.get(id);
    if (!config) {
      // The proxies catalog was loaded once at the top of the request, but
      // an admin can delete a row mid-flight. Treat the missing id as a
      // dial-shaped failure for THIS entry so the fallback chain advances
      // instead of killing the whole call (and any healthy `direct` /
      // sibling entries further down the list). We don't write to backoff
      // here — the row is gone, and the upstream's fallback_list will
      // surface the dangling reference next time the dashboard renders it.
      errors.push(new ProxyDialError(`unknown proxy id in fallback list: ${id}`, 'config'));
      return null;
    }
    const proxied = await proxiedFor();
    // Caller cancellation flows through init.signal into the dialer's
    // combined controller so a disconnected client tears down any
    // in-flight handshake instead of waiting for the per-proxy deadline.
    const options: RunProxiedRequestOptions = {
      socketDial: input.socketDial(),
      signal: init.signal ?? undefined,
    };
    if (config.dialTimeoutMs !== null) options.dialTimeoutMs = config.dialTimeoutMs;
    const response = await wrap(input.runProxied(
      config.config,
      proxied.target,
      proxied.request,
      options,
    ));
    // A successful dial after a previous failure must clear the backoff so
    // the next failure restarts at n=1 instead of resuming the geometric
    // schedule from where it left off. Mirror the failure-path policy: a
    // transient backoff-store write must not shadow the actual outcome —
    // here that means a bookkeeping rejection cannot discard a healthy
    // upstream Response we already hold.
    try {
      await input.repo.proxyBackoffs.recordDialSuccess(id, input.upstreamId);
    } catch (recordErr) {
      console.warn(`failed to clear proxy backoff for ${id}/${input.upstreamId}:`, recordErr);
    }
    return response;
  } catch (err) {
    // Caller-driven cancellation must propagate up immediately. Without
    // this, a client disconnect would let the dial chain continue burning
    // the deadline budget against every other entry in the list.
    if (isAbortError(err)) {
      throw err;
    }
    if (id === DIRECT_PROXY_ID) {
      // Direct egress can fail for the same dial-shaped reasons a proxy can
      // (TCP refused, GFW SNI reset, DNS, connect timeout). Runtime fetch
      // surfaces those as plain Errors / TypeErrors, not ProxyDialError, but
      // for fallback semantics they ARE dial failures — request bytes never
      // reached an upstream. Advance to the next entry like we would for a
      // proxy, just without touching the backoff table (no proxy entity to
      // throttle here).
      errors.push(err);
      return null;
    }
    if (err instanceof ProxyDialError) {
      errors.push(err);
      // Tag the persisted message with the dial stage so a dashboard reader
      // can tell a tcp-connect refusal from an inner-tls cert mismatch
      // without cracking the proxy library open. A transient backoff-store
      // failure must not shadow the real dial error — log and swallow so
      // `errors[]` carries the original cause up to the caller.
      try {
        await input.repo.proxyBackoffs.recordDialFailure(id, input.upstreamId, `[${err.stage}] ${err.message}`);
      } catch (recordErr) {
        console.warn(`failed to persist proxy backoff for ${id}/${input.upstreamId}:`, recordErr);
      }
      return null;
    }
    throw err;
  }
};

const buildProxiedRequest = async (url: string, init: RequestInit): Promise<ProxiedRequest> => {
  const u = new URL(url);
  const collected = await collectBody(init.body);
  const headers = extractHeaders(init.headers);
  // FormData/URLSearchParams synthesize a Content-Type with the multipart
  // boundary or the urlencoded marker. Adopt it only when the caller did not
  // pre-set Content-Type itself, so explicit overrides keep winning.
  if (collected?.contentType !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = collected.contentType;
  }
  // `URL#hostname` keeps the `[…]` envelope on IPv6 literals; the
  // `DialTarget.host` contract requires the bare address. Strip the
  // brackets here at the URL→DialTarget seam so every dialer sees a
  // canonical host.
  const target: ProxyRequestTarget = {
    host: normalizeDialHost(u.hostname),
    port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
    tls: u.protocol === 'https:',
  };
  const request: HttpRequest = {
    method: init.method ?? 'GET',
    path: `${u.pathname}${u.search}`,
    headers,
    body: collected?.body,
  };
  return { target, request };
};

// Lower-case keys here so the request is canonical at the seam; the http
// package also lowercases internally, but normalizing at the boundary
// keeps the contract simple.
const extractHeaders = (input: HeadersInit | undefined): Record<string, string> => {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: Record<string, string> = {};
    input.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  if (Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [k, v] of input) out[k.toLowerCase()] = v;
    return out;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[k.toLowerCase()] = v;
  return out;
};

interface CollectedBody {
  body: Uint8Array;
  /** Content-Type the runtime synthesizes for FormData/URLSearchParams (with
   *  multipart boundary or urlencoded marker). undefined for shapes that
   *  carry no implicit Content-Type. */
  contentType?: string;
}

const collectBody = async (
  body: BodyInit | null | undefined,
): Promise<CollectedBody | undefined> => {
  if (body == null) return undefined;
  if (typeof body === 'string') return { body: new TextEncoder().encode(body) };
  if (body instanceof Uint8Array) return { body };
  if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) };
  if (body instanceof Blob) return { body: new Uint8Array(await body.arrayBuffer()) };
  // FormData / URLSearchParams: round-trip through Request so the runtime
  // produces a canonical multipart/url-encoded byte stream we can buffer
  // alongside the synthesized Content-Type (with boundary or charset).
  if (body instanceof FormData || body instanceof URLSearchParams) {
    const req = new Request('https://internal/', { method: 'POST', body });
    const buffer = new Uint8Array(await req.arrayBuffer());
    const contentType = req.headers.get('content-type') ?? undefined;
    return { body: buffer, contentType };
  }
  throw new Error('unsupported BodyInit shape for proxied request');
};
