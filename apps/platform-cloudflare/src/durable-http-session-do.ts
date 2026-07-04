import { DurableObject } from 'cloudflare:workers';

import { HeldSocket } from './_held-socket.ts';
import { cloudflareSocketDial } from './socket-dial.ts';
import { fetchOnStream } from '@floway-dev/http';
import { normalizeDialHost } from '@floway-dev/platform';
import { runProxiedRequest, type ProxyConfig } from '@floway-dev/proxy';

// DurableHttpSessionDO — one instance per sessionKey. It is the first actor in
// the workspace that owns a live OUTBOUND socket: it dials the upstream with
// `cloudflare:sockets`, runs one HTTP/1.1 request over it via fetchOnStream,
// and holds the still-streaming response body open across many inbound Worker
// requests. The outbound socket keeps the DO alive (CF 2026-06-19: outbound
// connections keep DOs alive, up to a 15-minute cap); an idle alarm evicts an
// abandoned session before then. Semantic upgrade over BroadcastDO (a pure
// message bus that touches no external resource) — documented here and in
// wrangler.example.jsonc.
//
// The body bytes reach the broker (which may live in another isolate) over a
// WebSocket: the DO pumps response.body into the attached consumer socket, and
// buffers between consumers so a release()→re-acquire() continues mid-stream
// (the DurableHttpSession contract: releasing a handle must not cancel the
// upstream read). Protocol decoding stays entirely with the caller.

// `start` reply / RPC-friendly shapes (structured-clone-safe).
export interface DurableHttpSessionStartInit {
  method: 'POST' | 'GET' | 'PUT' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
  /** Opaque ProxyConfig[] to dial through (see DurableHttpSessionInit.proxies). */
  proxies?: unknown[];
}

export interface DurableHttpSessionStartResult {
  status: number;
  headers: [string, string][];
}

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Hard cap on bytes buffered while no consumer is attached. Overflow means a
// consumer fell behind or vanished mid-stream — discard so the next acquire
// starts fresh rather than letting the actor grow unbounded.
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MiB

export class DurableHttpSessionDO extends DurableObject {
  private held: HeldSocket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private statusCode = 0;
  private headerList: [string, string][] = [];
  private started = false;
  private done = false;
  private errored = false;
  // Bytes read off the upstream while no consumer is attached. Chunks are
  // pushed at the tail and consumed via a head-index cursor so a burst that
  // buffers dozens of chunks doesn't pay O(n) per shift.
  private buffer: Uint8Array[] = [];
  private bufferHead = 0;
  private bufferedBytes = 0;
  private consumer: WebSocket | null = null;
  // Chunks the current consumer has requested (one credit per broker-side
  // ReadableStream pull) but not yet been sent. Reset on attach/release/discard.
  private credits = 0;
  private idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  private lastActivityAt = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  /**
   * Broker entrypoint. Returns the response meta if a session is live (hit),
   * starts one from `init` if not (miss + init), or returns null (miss +
   * init=null) so the caller can degrade to a new conversation.
   */
  async queryOrStart(
    init: DurableHttpSessionStartInit | null,
    idleTimeoutMs: number,
  ): Promise<DurableHttpSessionStartResult | null> {
    if (this.started && !this.errored) {
      this.touch();
      return { status: this.statusCode, headers: this.headerList };
    }
    if (!init) return null;
    return await this.start(init, idleTimeoutMs);
  }

  private async start(
    init: DurableHttpSessionStartInit,
    idleTimeoutMs: number,
  ): Promise<DurableHttpSessionStartResult> {
    this.idleTimeoutMs = idleTimeoutMs > 0 ? idleTimeoutMs : DEFAULT_IDLE_TIMEOUT_MS;
    const url = new URL(init.url);
    const tls = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : (tls ? 443 : 80);

    const path = `${url.pathname}${url.search}`;
    // Host is mandatory on HTTP/1.1; derive it from the URL rather than
    // trusting the caller to pass it (fetchOnStream validates/forwards the rest).
    const headers: Record<string, string> = { Host: url.host, ...init.headers };
    let response: Response;
    try {
      const proxies = (init.proxies ?? []) as ProxyConfig[];
      if (proxies.length > 0) {
        // Proxied dial (streaming): runProxiedRequest composes dial → TLS →
        // fetch-on-stream over the CF socket dial. Try each in order. No
        // HeldSocket: discard cancels the response body, which tears down the
        // proxied transport.
        const target = { host: normalizeDialHost(url.hostname), port, tls };
        const request = { method: init.method, path, headers, body: init.body };
        let lastErr: unknown;
        let proxied: Response | null = null;
        for (const config of proxies) {
          try { proxied = await runProxiedRequest(config, target, request, { socketDial: cloudflareSocketDial }); break; } catch (err) { lastErr = err; }
        }
        if (!proxied) throw lastErr ?? new Error('all proxies failed for DurableHttpSessionDO dial');
        response = proxied;
      } else {
        const dialed = await cloudflareSocketDial.connect(url.hostname, port, { tls });
        this.held = new HeldSocket(dialed);
        response = await fetchOnStream(this.held.asDuplex(), {
          method: init.method,
          path,
          headers,
          body: init.body,
        });
      }
    } catch (err) {
      await this.discard(`upstream dial/request failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    if (!response.body) {
      await this.discard('upstream returned no body');
      throw new Error(`DurableHttpSessionDO: ${init.method} ${init.url} returned no body`);
    }

    this.statusCode = response.status;
    this.headerList = [...response.headers];
    this.reader = response.body.getReader();
    this.started = true;
    this.touch();
    this.startPump();
    await this.ctx.storage.setAlarm(Date.now() + this.idleTimeoutMs);
    return { status: this.statusCode, headers: this.headerList };
  }

  // Continuously drain the upstream reader into `buffer`, then hand chunks to
  // the consumer only as fast as it credits them (see flushToConsumer). A
  // consumer that pauses reading stops crediting, so subsequent chunks stay
  // buffered for the next acquire instead of being pushed at a WS about to close.
  private startPump(): void {
    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await this.reader!.read();
          if (done) {
            this.done = true;
            this.flushToConsumer();
            return;
          }
          if (!value || value.byteLength === 0) continue;
          this.buffer.push(value);
          this.bufferedBytes += value.byteLength;
          if (this.bufferedBytes > MAX_BUFFERED_BYTES) {
            await this.discard('buffer overflow with no consumer');
            return;
          }
          this.flushToConsumer();
        }
      } catch (err) {
        this.errored = true;
        this.done = true;
        this.consumer?.close(1011, `upstream error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void pump();
  }

  // Deliver buffered chunks to the consumer up to the credits it has requested
  // (the broker sends one credit per ReadableStream pull). A send that throws
  // leaves the chunk at the head of `buffer` — never dropped — and detaches the
  // dead consumer so the next acquire resumes from the same point. Once the
  // upstream is done and the buffer is fully drained, a waiting credit gets the
  // end-of-stream close.
  private flushToConsumer(): void {
    while (this.consumer && this.credits > 0 && this.bufferHead < this.buffer.length) {
      const chunk = this.buffer[this.bufferHead]!;
      try {
        this.consumer.send(chunk);
      } catch {
        this.consumer = null;
        return;
      }
      this.bufferHead += 1;
      this.bufferedBytes -= chunk.byteLength;
      this.credits -= 1;
    }
    // Reclaim: once the head has walked past every live element the two ends
    // are back at 0, releasing the underlying array so a subsequent burst
    // doesn't grow the array unboundedly with dead prefix entries.
    if (this.bufferHead > 0 && this.bufferHead >= this.buffer.length) {
      this.buffer = [];
      this.bufferHead = 0;
    }
    if (this.consumer && this.credits > 0 && this.done && this.bufferHead >= this.buffer.length) {
      try {
        this.consumer.close(1000, this.errored ? 'upstream error' : 'upstream ended');
      } catch { /* already closing */ }
    }
  }

  /**
   * WebSocket upgrade from the broker. Accepts the server side, flushes any
   * buffered bytes, then forwards live frames until the consumer disconnects.
   */
  async fetch(_request: Request): Promise<Response> {
    if (!this.started) {
      return new Response('session not started', { status: 409 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.attachConsumer(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private attachConsumer(ws: WebSocket): void {
    this.consumer = ws;
    this.credits = 0;
    this.touch();
    // Each inbound message is one credit — "send me one more chunk". The broker
    // sends exactly one per ReadableStream pull, giving strict 1:1 backpressure.
    ws.addEventListener('message', () => {
      if (this.consumer !== ws) return;
      this.credits += 1;
      this.touch();
      this.flushToConsumer();
    });
    ws.addEventListener('close', () => {
      if (this.consumer === ws) {
        this.consumer = null;
        this.touch();
      }
    });
    ws.addEventListener('error', () => {
      if (this.consumer === ws) this.consumer = null;
    });
    // No eager flush and no done-close here: delivery is credit-driven, so a
    // fresh consumer starts receiving only once it pulls (credits arrive).
    this.flushToConsumer();
  }

  /**
   * Detach the current consumer's hold. The upstream read keeps flowing into
   * the buffer so the next acquire continues mid-stream. Idempotent — the
   * consumer reference also clears on its own WS 'close' event.
   */
  async release(): Promise<void> {
    // Detach the consumer and drop its outstanding credits; the buffer is
    // retained so the next acquire continues mid-stream. Because delivery is
    // credit-driven, any chunk the pump reads after this point simply stays
    // buffered (the paused turn never credited it), so nothing is pushed at the
    // detaching socket. The provider side closes its WS end independently.
    this.consumer = null;
    this.credits = 0;
    this.touch();
  }

  /** Forcibly tear down the upstream connection and clear all state. Idempotent. */
  async discard(reason: string): Promise<void> {
    this.done = true;
    try { this.consumer?.close(1000, reason); } catch { /* already closing */ }
    this.consumer = null;
    this.credits = 0;
    const reader = this.reader;
    this.reader = null;
    if (reader) { try { await reader.cancel(reason); } catch { /* already done */ } }
    const held = this.held;
    this.held = null;
    if (held) { try { await held.close(); } catch { /* idempotent */ } }
    this.buffer = [];
    this.bufferHead = 0;
    this.bufferedBytes = 0;
    this.started = false;
    try { await this.ctx.storage.deleteAlarm(); } catch { /* no alarm set */ }
  }

  // Idle eviction. Re-arms while activity is recent; otherwise tears the
  // session down so an abandoned conversation — including one whose consumer
  // is still attached but has gone silent — does not pin the outbound socket
  // to the 15-minute runtime cap.
  async alarm(): Promise<void> {
    const idleMs = Date.now() - this.lastActivityAt;
    if (idleMs >= this.idleTimeoutMs) {
      await this.discard('idle timeout');
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + this.idleTimeoutMs);
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  // Hibernation close hooks (mirrors BroadcastDO): complete the close
  // handshake from the actor side so a consumer never sees a 1006 abnormal
  // closure, and drop our reference to the gone socket.
  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    if (this.consumer === ws) this.consumer = null;
    try { ws.close(code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    if (this.consumer === ws) this.consumer = null;
  }
}
