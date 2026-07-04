// Cross-request HTTP response holder. Each runtime supplies a concrete impl
// via initDurableHttpSession; callers obtain it via getDurableHttpSession().
//
// Distinct from SocketDial in two ways:
//   1. Lifetime: SocketDial returns a connection valid for one request;
//      DurableHttpSession keeps a request/response pair alive across many
//      inbound HTTP requests until idle timeout or explicit discard.
//   2. Granularity: SocketDial deals in bytes; DurableHttpSession deals in
//      an in-progress HTTP/1.1 response (status + headers + still-streaming
//      body). Protocol decoding stays with the caller.
//
// Use case: providers whose upstream protocol needs a single long-lived
// response body that outlives the inbound HTTP request that triggered it —
// the same logical conversation continues via later inbound requests that
// piggy-back tool results onto the still-open upstream read.

export interface DurableHttpSessionInit {
  method: 'POST' | 'GET' | 'PUT' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  /**
   * Ordered proxy configs (opaque `@floway-dev/proxy` ProxyConfig) to dial the
   * upstream through, tried in order; empty/absent = direct. The contract keeps
   * this opaque so the platform package doesn't depend on @floway-dev/proxy —
   * the concrete impls cast and call runProxiedRequest. Streaming responses
   * can't go through the gateway's buffered proxy Fetcher, so the session
   * does its own proxied dial.
   */
  proxies?: unknown[];
}

export interface DurableHttpSessionHandle {
  /** Response status from the upstream. */
  readonly status: number;
  /** Response headers from the upstream. */
  readonly headers: Headers;
  /**
   * The response body stream. Each acquire returns a fresh ReadableStream
   * view; releasing this handle does NOT cancel the underlying upstream
   * read — the next acquire continues from wherever the stream is. Calling
   * cancel() on this stream releases this consumer's hold but the
   * underlying read keeps flowing into the broker's buffer.
   */
  readonly body: ReadableStream<Uint8Array>;
  /**
   * Release this handle's hold on the session. The session itself stays
   * alive in the pool for the next acquire. Idempotent.
   */
  release(): Promise<void>;
  /**
   * Forcibly close the underlying upstream connection and evict the
   * session from the pool. Idempotent. Use when the protocol layer
   * detects an unrecoverable state (framing error, upstream RST, etc.)
   * so the next acquire must start a fresh upstream request.
   */
  discard(reason: string): Promise<void>;
}

export interface DurableHttpSessionAcquireOptions {
  /**
   * Idle TTL — when no acquire holds the session for this many ms, the
   * impl closes the upstream connection and evicts the entry. Default
   * is impl-defined (Node InProcess uses 5 min; CF DO uses an alarm).
   */
  idleTimeoutMs?: number;
  /**
   * Caller-supplied cancellation. Aborting the signal releases this
   * acquire's handle. It does NOT discard the session — sibling acquires
   * keep working.
   */
  signal?: AbortSignal;
}

export interface DurableHttpSession {
  /**
   * Acquire a handle to the session keyed by sessionKey.
   *
   * Semantics:
   *   - hit + init=null:    return a handle to the existing session
   *   - hit + init non-null: ignore init (existing session wins; callers
   *                          wanting to force a new upstream request must
   *                          discard first)
   *   - miss + init non-null: open a new upstream request and seed the
   *                          session before returning a handle
   *   - miss + init=null:   return null (caller decides degradation —
   *                         typically "treat as new conversation")
   *
   * Concurrent acquires for the same sessionKey are serialized inside the
   * impl (Node uses a promise lock; CF DO actor is single-threaded by
   * runtime). Callers do not need to synchronize.
   */
  acquire(
    sessionKey: string,
    init: DurableHttpSessionInit | null,
    opts?: DurableHttpSessionAcquireOptions,
  ): Promise<DurableHttpSessionHandle | null>;
}

let current: DurableHttpSession | null = null;

export const initDurableHttpSession = (impl: DurableHttpSession): void => {
  current = impl;
};

export const getDurableHttpSession = (): DurableHttpSession => {
  if (!current) throw new Error('DurableHttpSession not initialized — call initDurableHttpSession() first');
  return current;
};

/** Test-only: clears the module singleton. */
export const resetDurableHttpSessionForTesting = (): void => {
  current = null;
};

// ---------------------------------------------------------------------------
// In-memory test fake. Same colocation convention as MemoryFileProvider in
// file-provider.ts — the fake travels with the contract so any consumer that
// imports the contract can also import the fake without a peer dependency.
// ---------------------------------------------------------------------------

/**
 * Scripted body for a fake session: an async iterable of byte chunks the
 * fake will hand out through the body stream, plus the status/headers it
 * reports. The same script is replayed for each fresh-create acquire; an
 * acquire that hits an existing session yields a new ReadableStream
 * draining what is left of the script.
 */
export interface FakeDurableHttpSessionScript {
  status: number;
  headers: Record<string, string>;
  /** Each yielded chunk is one ReadableStream enqueue. */
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

/**
 * In-memory DurableHttpSession for unit tests. Captures every acquire/
 * release/discard with full init so tests can assert what the provider
 * asked the broker to do, and reproduces multi-turn session reuse: an
 * acquire(key, null) after a prior acquire(key, init) hits the cached
 * entry and replays the same script.
 */
export class FakeDurableHttpSession implements DurableHttpSession {
  /** Override what script to return for a given sessionKey. Set before the test runs. */
  readonly scripts = new Map<string, FakeDurableHttpSessionScript>();
  /** Audit log of every acquire call, in order. */
  readonly acquired: Array<{ sessionKey: string; init: DurableHttpSessionInit | null }> = [];
  /** Audit log of every release call, in order. */
  readonly released: string[] = [];
  /** Audit log of every discard call, in order. */
  readonly discarded: Array<{ sessionKey: string; reason: string }> = [];

  private readonly entries = new Map<string, FakeDurableHttpSessionScript>();

  async acquire(
    sessionKey: string,
    init: DurableHttpSessionInit | null,
  ): Promise<DurableHttpSessionHandle | null> {
    this.acquired.push({ sessionKey, init });

    let script = this.entries.get(sessionKey);
    if (!script) {
      if (init === null) return null; // miss + no init → caller must degrade
      const seed = this.scripts.get(sessionKey);
      if (!seed) {
        throw new Error(`FakeDurableHttpSession: no script registered for sessionKey ${sessionKey}`);
      }
      script = seed;
      this.entries.set(sessionKey, script);
    }

    const body = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        for await (const chunk of script.body) controller.enqueue(chunk);
        controller.close();
      },
    });

    const self = this;
    return {
      status: script.status,
      headers: new Headers(script.headers),
      body,
      async release(): Promise<void> {
        self.released.push(sessionKey);
      },
      async discard(reason: string): Promise<void> {
        self.discarded.push({ sessionKey, reason });
        self.entries.delete(sessionKey);
      },
    };
  }
}
