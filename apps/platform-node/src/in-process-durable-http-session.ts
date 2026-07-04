import {
  getSocketDial,
  normalizeDialHost,
  type DurableHttpSession,
  type DurableHttpSessionAcquireOptions,
  type DurableHttpSessionHandle,
  type DurableHttpSessionInit,
} from '@floway-dev/platform';
import { runProxiedRequest, type ProxyConfig } from '@floway-dev/proxy';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// Dial the upstream: direct via globalThis.fetch (undici), or — when the init
// carries proxies — through them in order via runProxiedRequest (which streams,
// unlike the gateway's buffered proxy Fetcher), falling back to the next on a
// dial failure.
const dialUpstream = async (init: DurableHttpSessionInit): Promise<Response> => {
  const proxies = (init.proxies ?? []) as ProxyConfig[];
  if (proxies.length === 0) {
    return await globalThis.fetch(init.url, {
      method: init.method,
      headers: init.headers,
      body: init.body ? (init.body as BodyInit) : null,
    });
  }
  const u = new URL(init.url);
  const target = { host: normalizeDialHost(u.hostname), port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80), tls: u.protocol === 'https:' };
  const request = { method: init.method, path: `${u.pathname}${u.search}`, headers: init.headers, body: init.body };
  const socketDial = getSocketDial();
  let lastErr: unknown;
  for (const config of proxies) {
    try {
      return await runProxiedRequest(config, target, request, { socketDial });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('all proxies failed for DurableHttpSession dial');
};

interface Entry {
  response: Response;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Buffered chunks not yet consumed by the current handle. */
  buffer: Uint8Array[];
  /** Resolves the next dequeue when a chunk arrives or the stream ends. */
  waiter: { resolve: (v: { done: boolean; value?: Uint8Array }) => void } | null;
  done: boolean;
  error: unknown;
  inFlight: Promise<unknown> | null;
  idleTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
}

export class InProcessDurableHttpSession implements DurableHttpSession {
  private readonly entries = new Map<string, Entry>();

  async acquire(
    sessionKey: string,
    init: DurableHttpSessionInit | null,
    opts?: DurableHttpSessionAcquireOptions,
  ): Promise<DurableHttpSessionHandle | null> {
    const idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    const existingInFlight = this.entries.get(sessionKey)?.inFlight;
    if (existingInFlight) await existingInFlight.catch(() => {});

    let entry = this.entries.get(sessionKey);

    if (!entry) {
      if (init === null) return null;
      const lock = (async (): Promise<Entry> => {
        const response = await dialUpstream(init);
        if (!response.body) {
          throw new Error(`InProcessDurableHttpSession: ${init.method} ${init.url} returned no body`);
        }
        const reader = response.body.getReader();
        const e: Entry = {
          response,
          reader,
          buffer: [],
          waiter: null,
          done: false,
          error: null,
          inFlight: null,
          idleTimer: null,
          lastActivityAt: Date.now(),
        };
        this.startPump(e);
        return e;
      })();
      const placeholder: Entry = {
        response: undefined as unknown as Response,
        reader: undefined as unknown as ReadableStreamDefaultReader<Uint8Array>,
        buffer: [],
        waiter: null,
        done: false,
        error: null,
        inFlight: lock,
        idleTimer: null,
        lastActivityAt: Date.now(),
      };
      this.entries.set(sessionKey, placeholder);
      try {
        entry = await lock;
        this.entries.set(sessionKey, entry);
      } catch (err) {
        this.entries.delete(sessionKey);
        throw err;
      }
    }

    entry.lastActivityAt = Date.now();
    this.armIdleTimer(sessionKey, entry, idleTimeoutMs);
    return this.makeHandle(sessionKey, entry, opts?.signal);
  }

  private startPump(entry: Entry): void {
    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await entry.reader.read();
          if (done) {
            entry.done = true;
            if (entry.waiter) {
              entry.waiter.resolve({ done: true });
              entry.waiter = null;
            }
            return;
          }
          if (value) {
            if (entry.waiter) {
              entry.waiter.resolve({ done: false, value });
              entry.waiter = null;
            } else {
              entry.buffer.push(value);
            }
          }
        }
      } catch (err) {
        entry.error = err;
        entry.done = true;
        if (entry.waiter) {
          entry.waiter.resolve({ done: true });
          entry.waiter = null;
        }
      }
    };
    void pump();
  }

  private dequeue(entry: Entry): Promise<{ done: boolean; value?: Uint8Array }> {
    if (entry.buffer.length > 0) {
      return Promise.resolve({ done: false, value: entry.buffer.shift()! });
    }
    if (entry.done) {
      return Promise.resolve({ done: true });
    }
    return new Promise(resolve => { entry.waiter = { resolve }; });
  }

  private armIdleTimer(sessionKey: string, entry: Entry, idleTimeoutMs: number): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => this.evict(sessionKey, 'idle timeout'), idleTimeoutMs);
    entry.idleTimer.unref?.();
  }

  private evict(sessionKey: string, _reason: string): void {
    const entry = this.entries.get(sessionKey);
    if (!entry) return;
    this.entries.delete(sessionKey);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.reader.releaseLock(); } catch { /* already released */ }
    void entry.response.body?.cancel(_reason).catch(() => {});
  }

  private makeHandle(
    sessionKey: string,
    entry: Entry,
    signal: AbortSignal | undefined,
  ): DurableHttpSessionHandle {
    const self = this;
    let released = false;
    const onAbort = (): void => { released = true; };
    if (signal) {
      if (signal.aborted) released = true;
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    // highWaterMark 0: the stream only pulls to satisfy an active read() — it
    // never speculatively reads ahead. Without this, the default hWM of 1
    // makes the stream pull a chunk into its own internal queue (or park a
    // waiter) right after the consumer's last read, so during a mid-turn
    // pause a chunk the upstream sends next can land in the about-to-be-
    // discarded view instead of the shared entry buffer — lost across the
    // turn handoff, wedging the upstream. Pulling 1:1 with reads mirrors
    // reading the socket directly.
    const body = new ReadableStream<Uint8Array>({
      async pull(controller): Promise<void> {
        if (released) { controller.close(); return; }
        const result = await self.dequeue(entry);
        if (released || result.done) { controller.close(); return; }
        if (result.value) controller.enqueue(result.value);
      },
      cancel(): void {
        released = true;
        if (signal) signal.removeEventListener('abort', onAbort);
      },
    }, { highWaterMark: 0 });

    return {
      status: entry.response.status,
      headers: entry.response.headers,
      body,
      async release(): Promise<void> {
        released = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        // Abandon any dequeue this view left pending. The stream pulls ahead, so
        // at the pause point view A is usually parked on an empty-buffer waiter.
        // If we leave it, the pump delivers the next chunk (the first byte the
        // upstream sends after the tool result) to this dead stream — it is lost
        // and never acked, wedging the upstream. Close view A's pull and null the
        // slot so the next chunk buffers for the next acquirer instead.
        if (entry.waiter) {
          entry.waiter.resolve({ done: true });
          entry.waiter = null;
        }
      },
      async discard(reason: string): Promise<void> {
        released = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        self.evict(sessionKey, reason);
      },
    };
  }

  evictAllForTesting(): void {
    for (const key of [...this.entries.keys()]) this.evict(key, 'test reset');
  }

  sizeForTesting(): number {
    return this.entries.size;
  }
}
