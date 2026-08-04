import type { ProxyEntry } from './proxy-catalog.ts';
import { createReplayableRequest, type ReplayableRequest } from './replayable-request.ts';
import { DIRECT_CONNECT_ID, DIRECT_FETCH_ID, entryMatchesColo, isDirectFallbackId } from '../repo/proxy-fallback-list.ts';
import type { Repo } from '../repo/types.ts';
import type { HttpRequest } from '@floway-dev/http';
import type { Fetcher, ProxyFallbackEntry } from '@floway-dev/provider';
import { isAbortError } from '@floway-dev/provider';
import { ProxyDialError, type ProxyConfig, type ProxyRequestTarget, type RunDirectConnectRequestOptions, type RunProxiedRequestOptions, type SocketDial } from '@floway-dev/proxy';

interface CreateFetcherInput {
  repo: Pick<Repo, 'proxyBackoffs'>;
  upstreamId: string;
  fallbackList: ProxyFallbackEntry[];
  proxyById: Map<string, ProxyEntry>;
  // Location tag the request landed in, used to apply each entry's optional
  // `colos` whitelist via `entryMatchesColo`. See `getRuntimeLocation`.
  runtimeLocation: string;
  // Injected so the fetcher stays runtime-agnostic — the composition root
  // chooses the concrete dial/fetch implementations.
  runProxied: (
    config: ProxyConfig,
    target: ProxyRequestTarget,
    request: HttpRequest,
    options: RunProxiedRequestOptions,
  ) => Promise<Response>;
  // Per-request indirection for the runtime-native fetch sentinel.
  runDirectFetch: (url: string, init: RequestInit) => Promise<Response>;
  // Runtime-agnostic raw TCP + userspace-TLS request runner.
  runDirectConnect: (
    target: ProxyRequestTarget,
    request: HttpRequest,
    options: RunDirectConnectRequestOptions,
  ) => Promise<Response>;
  /**
   * Platform-injected byte-stream dial, threaded into runProxied. Each dialer
   * asks through `SocketDialOptions` for either a raw connection or one
   * wrapped in the runtime's native TLS.
   * Lazily evaluated — only invoked when a socket-backed fallback entry is
   * actually attempted, so direct-fetch-only call sites can run without an
   * installed SocketDial impl.
   */
  socketDial: () => SocketDial;
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
// Body buffering is deferred until a proxy or direct-connect candidate needs
// it; the direct-fetch-only fast path passes `init` straight to runtime `fetch`,
// which is how non-buffered shapes like FormData stay supported.
export const createFetcher = (input: CreateFetcherInput): Fetcher => {
  // An unset policy means direct egress, and direct egress defaults to raw TCP
  // rather than the runtime's `fetch`, because both runtimes' `fetch` abandon a
  // response whose body goes quiet for long enough. Cloudflare routes a Worker
  // `fetch` body through its HTTP proxy path, whose Proxy Read Timeout bounds
  // the gap between two consecutive reads of the upstream response at 120s;
  // Node's `fetch` is undici, whose `bodyTimeout` "monitors time between
  // receiving body data" and defaults to 300s. Either one kills a Copilot
  // Responses stream that has already returned HTTP 200 and then thinks —
  // measured silences run past both bounds (120s and 300.113s observed on the
  // same workload), and neither limit is reachable from here. A raw socket has
  // no such bound: the same workload survived 233s of measured upstream silence
  // and completed cleanly (https://github.com/Menci/Floway/pull/221).
  // `direct_fetch` keeps the runtime connection pool and HTTP/2, so it stays
  // selectable, but an operator has to ask for it.
  //   https://developers.cloudflare.com/cache/how-to/cache-rules/settings/#proxy-read-timeout-enterprise-only
  //   https://github.com/nodejs/undici/blob/7392d6f9f565e550e9047458c275ae77aeaefbb9/docs/docs/api/Client.md?plain=1#L20
  //
  // Colo filter precedes the implicit direct-connect collapse so a fully-excluded
  // list behaves like an empty list and gets the direct-connect fallback, rather than
  // throwing because pass 1 had no candidates.
  const matched = input.fallbackList.filter(entry => entryMatchesColo(entry, input.runtimeLocation));
  const list = matched.length > 0 ? matched.map(entry => entry.id) : [DIRECT_CONNECT_ID];
  // If direct-fetch precedes any materialized transport, runtime fetch may take
  // ownership of `init.body` and consume its underlying stream/Blob.
  // Buffer the body up-front so a runtime that re-streams a Blob can't
  // strand a later proxy attempt with empty bytes. The fast path
  // (direct-fetch-only list) keeps the runtime's native body handling intact —
  // FormData, Blob, etc. don't need to be buffered.
  const hasMaterializedTransport = list.some(id => id !== DIRECT_FETCH_ID);
  const hasDirectFetch = list.includes(DIRECT_FETCH_ID);
  const directFetchBeforeMaterialized = hasMaterializedTransport
    && hasDirectFetch
    && list.indexOf(DIRECT_FETCH_ID) < list.length - 1;
  return (url, init) => {
    // Reject streaming bodies upfront whenever any materialized entry is in
    // play. The two-pass dial can replay a request and a stream is
    // single-shot; for a list like ['a','direct_fetch'] where 'a' is in active
    // backoff, pass 1 would consume the stream via the runtime fetch and
    // strand pass 2 with empty bytes.
    if (hasMaterializedTransport && init.body instanceof ReadableStream) {
      return Promise.reject(new Error('streaming request bodies are not replayable through direct-connect or proxy transports'));
    }

    return runFallbacks(input, list, url, createReplayableRequest(url, init), directFetchBeforeMaterialized);
  };
};

const runFallbacks = async (
  input: CreateFetcherInput,
  list: readonly string[],
  url: string,
  request: ReplayableRequest,
  directFetchBeforeMaterialized: boolean,
): Promise<Response> => {
  // A direct-fetch attempt before a materialized transport can consume
  // Blob/FormData bodies. Build the replayable byte form first so every later
  // attempt observes one body.
  if (directFetchBeforeMaterialized) await request.materialized();
  const errors: unknown[] = [];

  // Backoff rows only ever exist for operator-managed proxies, so a list made
  // entirely of built-in transports has nothing to look up. Skipping the read
  // keeps the direct-only path — which is what an unset policy resolves to —
  // free of a per-request store round-trip.
  const skip = new Set<string>();
  if (list.some(id => !isDirectFallbackId(id))) {
    const active = await input.repo.proxyBackoffs.listForUpstream(input.upstreamId);
    const now = Math.floor(Date.now() / 1000);
    for (const b of active) if (b.expiresAt > now) skip.add(b.proxyId);
  }

  // Track which entries have already been attempted in this call so the
  // second pass only retries the ones we actively skipped. Without this,
  // a single dial failure would record TWO recordDialFailure calls — the
  // backoff schedule advertised in proxy-backoffs would double-step on
  // every real failure.
  const triedThisCall = new Set<string>();
  for (const id of list) {
    if (skip.has(id)) continue;
    triedThisCall.add(id);
    const result = await tryOne(id, input, request, url, errors);
    if (result) return result;
  }

  for (const id of list) {
    if (triedThisCall.has(id)) continue;
    const result = await tryOne(id, input, request, url, errors);
    if (result) return result;
  }

  // A single fallback entry that failed once still produces just one
  // ProxyDialError in `errors` — surface it directly so callers don't see
  // a meaningless AggregateError wrapper.
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'all proxies failed at the dial layer');
};

const tryOne = async (
  id: string,
  input: CreateFetcherInput,
  request: ReplayableRequest,
  url: string,
  errors: unknown[],
): Promise<Response | null> => {
  try {
    if (id === DIRECT_FETCH_ID) {
      // Direct egress is the runtime's fetch — it never raises ProxyDialError,
      // so we don't touch the backoff table for this entry.
      return await input.runDirectFetch(url, request.fetchInit());
    }
    if (id === DIRECT_CONNECT_ID) {
      const materialized = await request.materialized();
      return await input.runDirectConnect(
        materialized.target,
        materialized.request,
        { socketDial: input.socketDial(), signal: request.signal },
      );
    }
    const config = input.proxyById.get(id);
    if (!config) {
      // The proxies catalog was loaded once at the top of the request, but
      // an admin can delete a row mid-flight. Treat the missing id as a
      // dial-shaped failure for THIS entry so the fallback chain advances
      // instead of killing the whole call (and any healthy built-in or proxy
      // siblings further down the list). We don't write to backoff
      // here — the row is gone.
      errors.push(new ProxyDialError(`unknown proxy id in fallback list: ${id}`, 'config'));
      return null;
    }
    const materialized = await request.materialized();
    // Caller cancellation flows through init.signal into the dialer's
    // combined controller so a disconnected client tears down any
    // in-flight handshake instead of waiting for the per-proxy deadline.
    const options: RunProxiedRequestOptions = {
      socketDial: input.socketDial(),
      signal: request.signal,
    };
    if (config.dialTimeoutMs !== null) options.dialTimeoutMs = config.dialTimeoutMs;
    const response = await input.runProxied(
      config.config,
      materialized.target,
      materialized.request,
      options,
    );
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
    if (id === DIRECT_FETCH_ID) {
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
    if (id === DIRECT_CONNECT_ID) {
      if (err instanceof ProxyDialError) {
        errors.push(err);
        return null;
      }
      throw err;
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
