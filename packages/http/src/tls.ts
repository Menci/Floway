// Userspace TLS adapter over a raw plain-TCP byte transport.
//
// Some runtimes' native `Socket.startTls()` cannot wrap a duplex that has
// already exchanged plain bytes — workerd is one example (issue #2712),
// which means proxy paths that finish a plaintext handshake (HTTP CONNECT,
// SOCKS5, …) cannot upgrade through the runtime's TLS primitive there. A
// userspace TLS client sidesteps the runtime entirely, so this package
// can offer the same TLS upgrade on every target.
//
// `@reclaimprotocol/tls` provides a TLS 1.2/1.3 client implemented in JS using
// Web Crypto + @noble. We wrap it as an adapter that takes a duplex byte
// transport and returns a fresh { readable, writable } pair carrying the
// upstream's decrypted application data.

import { makeTLSClient, setCryptoImplementation } from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';

import { signalAbortReason } from './abort.ts';
import { copy } from './bytes.ts';
import type { DuplexStream } from './types.ts';

let cryptoInstalled = false;
const ensureCrypto = (): void => {
  if (cryptoInstalled) return;
  setCryptoImplementation(webcryptoCrypto);
  cryptoInstalled = true;
};

// `@reclaimprotocol/tls`'s `loadRootCAs()` is module-memoised — it merges
// `MOZILLA_ROOT_CA_LIST` with `globalThis.TLS_ADDITIONAL_ROOT_CA_LIST` on
// first call and freezes the result, ignoring later additions. So every
// PEM that should reach the userspace TLS trust set has to land in the
// global *before* the first handshake. We push deduplicated by exact PEM
// string; the library normalises whitespace internally when parsing.
interface TrustGlobals { TLS_ADDITIONAL_ROOT_CA_LIST?: string[] }
export const addTrustedRootCAs = (pems: readonly string[]): void => {
  if (pems.length === 0) return;
  const g = globalThis as unknown as TrustGlobals;
  const list = (g.TLS_ADDITIONAL_ROOT_CA_LIST ??= []);
  const seen = new Set(list);
  for (const pem of pems) {
    if (seen.has(pem)) continue;
    seen.add(pem);
    list.push(pem);
  }
};

export interface UserspaceTlsOptions {
  /**
   * TLS peer identity. DNS names are sent in the ClientHello `server_name`
   * extension; IPv4 and IPv6 literals cause that extension to be omitted.
   * Also used for certificate verification unless `verifyHost` is set.
   */
  host: string;
  /**
   * Override the certificate reference identity independently from `host`.
   * An IP literal must match an `iPAddress` SAN. Defaults to `host`.
   */
  verifyHost?: string;
  alpn?: string[];
  /**
   * When true, all server certificates are accepted (no chain validation,
   * no name match).
   */
  insecure?: boolean;
  /**
   * Optional bytes prepended to our first record write to the transport.
   * Lets the caller coalesce a transport-handshake fragment with the
   * leading TLS ClientHello into one packet when an inspecting peer
   * expects them in the same record.
   */
  prefix?: Uint8Array;
  /**
   * Force TLS 1.3 cipher suites. Defaults to the AES-GCM suites because
   * `@reclaimprotocol/tls` routes them through Web Crypto, which is
   * hardware-accelerated by V8 (AES-NI on x86, the SHA extensions on
   * ARM); ChaCha20-Poly1305 falls back to `@noble/ciphers`' pure-JS
   * impl, which is roughly an order of magnitude slower per byte and
   * dominates the cost on short-lived connections.
   */
  cipherSuites?: Array<'TLS_AES_256_GCM_SHA384' | 'TLS_AES_128_GCM_SHA256' | 'TLS_CHACHA20_POLY1305_SHA256'>;
  /**
   * Cancellation. Aborting before or during the handshake rejects the
   * userspaceTls promise, cancels the read pump, and releases the writer
   * lock so the caller can close the transport. After the handshake, the
   * caller's ReadableStream cancel/WritableStream abort drive teardown.
   */
  signal?: AbortSignal;
}

export type TlsStream = DuplexStream;

// On error the returned promise rejects; on TLS clean-end the readable closes;
// on any error after handshake the readable errors.
export const userspaceTls = async (
  transport: DuplexStream,
  opts: UserspaceTlsOptions,
): Promise<TlsStream> => {
  ensureCrypto();

  if (opts.signal?.aborted) {
    throw signalAbortReason(opts.signal);
  }

  const writer = transport.writable.getWriter();
  const reader = transport.readable.getReader();

  // Detach the abort listener on every teardown path so a long-lived caller
  // signal (e.g. a request controller shared across many dials) doesn't
  // accumulate one closure per dial pinning the closed-over streams.
  let detachAbortListener: (() => void) | null = null;
  const cleanupSignal = (): void => {
    detachAbortListener?.();
    detachAbortListener = null;
  };

  // plainController is wired by the ReadableStream's start() hook below,
  // which fires synchronously the moment the constructor runs. Two
  // independent paths can drop the plaintext stream out from under us:
  // (1) reclaim's TLS client fires `onTlsEnd` once for the peer CLOSE_NOTIFY
  //     alert and again when the underlying transport reader returns done;
  // (2) the consumer cancels the readable after it has the full response,
  //     which closes the controller from the outside. Either way, a
  //     follow-up `controller.close()` / `controller.error()` /
  //     `controller.enqueue()` throws ERR_INVALID_STATE — and on Node there
  //     is no error event to swallow it, so the whole worker crashes. Latch
  //     the close on our side, and treat any throw from the controller as
  //     "already closed by the consumer."
  let plainController!: ReadableStreamDefaultController<Uint8Array>;
  let plainClosed = false;
  let handshakeOk = false;

  // Resolve when the handshake succeeds; reject on TLS-end or error before then.
  let handshakeResolve!: () => void;
  let handshakeReject!: (e: unknown) => void;
  const handshakeDone = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });
  // Register a sink for the rejection so it never lands as an unhandled
  // rejection if the pump's transport-EOF / abort path rejects before the
  // outer `await handshakeDone` (further down) attaches its own handler.
  // The real consumer of the rejection is still the await — this catch is
  // a passive observer.
  handshakeDone.catch(() => { /* main handler is the await below */ });

  const closePlain = (error?: unknown): void => {
    if (plainClosed) return;
    plainClosed = true;
    cleanupSignal();
    if (error) {
      try { plainController.error(error); } catch { /* already closed/errored */ }
    } else {
      try { plainController.close(); } catch { /* already closed/errored */ }
    }
    // On error, abort the underlying writer so the transport tears down
    // hard; on a clean teardown, emit a polite FIN. A bare `writer.close()`
    // on the error path would graceful-end a half whose readable just
    // errored, leaving an in-flight write awaiting a peer that's already
    // gone.
    if (error) void writer.abort(error).catch(logTlsTeardownError);
    else void writer.close().catch(logTlsTeardownError);
  };
  const safeEnqueue = (chunk: Uint8Array<ArrayBuffer>): void => {
    // Once `plainClosed` is set, the controller has been closed/errored by
    // a teardown path and the next reclaim-driven onApplicationData would
    // throw ERR_INVALID_STATE. The teardown reason is the source of truth
    // for the consumer; silently dropping post-close bytes here is correct.
    // BEFORE plainClosed, an enqueue throw is a real invariant violation —
    // route it through closePlain so the consumer's reader unsticks with
    // the actual error rather than hanging forever.
    if (plainClosed) return;
    try {
      plainController.enqueue(chunk);
    } catch (err) {
      closePlain(err);
    }
  };

  let pendingPrefix: Uint8Array | null = opts.prefix ?? null;

  // `@reclaimprotocol/tls`'s exported TLSClientOptions typing is missing
  // two things this call site uses: `verifyHost` (added by our pnpm patch)
  // and a relaxed `onTlsEnd` error type (we forward errors from the runtime
  // which can be non-Error rejects, but the upstream typing assumes
  // `Error`). Build the options against a locally extended adapter type so
  // we still get field-level checking on what we pass, then run a single
  // `as` at the call site to bridge to the upstream parameter shape. When
  // the upstream typing absorbs the patch, this extension type and the
  // cast become redundant.
  type PatchedTLSOptions = Parameters<typeof makeTLSClient>[0] & {
    verifyHost?: string;
    onTlsEnd?: (error?: unknown) => void;
  };
  const tlsOptions: PatchedTLSOptions = {
    host: opts.host,
    verifyHost: opts.verifyHost,
    verifyServerCertificate: !opts.insecure,
    applicationLayerProtocols: opts.alpn,
    cipherSuites: opts.cipherSuites ?? ['TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256'],
    write({ header, content }) {
      const prefixLen = pendingPrefix ? pendingPrefix.byteLength : 0;
      const out = new Uint8Array(prefixLen + header.byteLength + content.byteLength);
      let off = 0;
      if (pendingPrefix) {
        out.set(pendingPrefix, 0); off += prefixLen;
        pendingPrefix = null;
      }
      out.set(header, off); off += header.byteLength;
      out.set(content, off);
      writer.write(out).catch(e => {
        if (!handshakeOk) handshakeReject(e);
        else closePlain(e);
      });
    },
    onHandshake() {
      handshakeOk = true;
      handshakeResolve();
    },
    onApplicationData(plaintext) {
      if (plainClosed) return;
      safeEnqueue(copy(plaintext));
    },
    onTlsEnd(error) {
      if (!handshakeOk) {
        handshakeReject(error ?? new Error('TLS ended before handshake'));
        return;
      }
      closePlain(error);
    },
  };
  const tlsClient = makeTLSClient(tlsOptions as Parameters<typeof makeTLSClient>[0]);

  // App-data downward stream (TLS plaintext → consumer). The cancel hook
  // fires only after the duplex pair has been returned to the consumer,
  // so by then tlsClient is fully initialized.
  const plainReadable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c; },
    // Consumer-initiated cancel (response body fully read or aborted) tears
    // down our side of the duplex — flag so subsequent TLS-end callbacks
    // skip their controller calls, and signal end-of-stream upward. Mirror
    // closePlain's split: an Error reason means the consumer hit a failure,
    // so we abort the underlying writer rather than emit a polite FIN that
    // would block on a peer already gone; a clean cancel still closes.
    cancel(reason) {
      plainClosed = true;
      cleanupSignal();
      void tlsClient.end().catch(logTlsTeardownError);
      void reader.cancel(reason).catch(() => {});
      if (reason instanceof Error) void writer.abort(reason).catch(logTlsTeardownError);
      else void writer.close().catch(logTlsTeardownError);
    },
  });

  // App-data upward stream (consumer → TLS encrypt → transport). Same
  // post-return invariant applies — write/close/abort run only after the
  // handshake await resolves and the duplex pair is handed back.
  const plainWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      await tlsClient.write(chunk);
    },
    async close() {
      // Both promises must be awaited — a bare `void promise` discards
      // rejection and crashes Node with unhandled-rejection when the
      // underlying stream is already closed. Surface teardown errors via
      // a debug log so genuine bugs aren't silenced, but never let one
      // mask the close itself (peer already gone is normal here).
      try { await tlsClient.end(); } catch (e) { logTlsTeardownError(e); }
      try { await writer.close(); } catch (e) { logTlsTeardownError(e); }
    },
    async abort(reason) {
      try { await tlsClient.end(); } catch (e) { logTlsTeardownError(e); }
      try { await writer.abort(reason); } catch (e) { logTlsTeardownError(e); }
    },
  });

  // Pump bytes from transport → tls.handleReceivedBytes. Errors and
  // teardown are handled inside the IIFE; the outer flow only awaits the
  // handshake, so the pump's promise is intentionally not awaited.
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          await tlsClient.end().catch(logTlsTeardownError);
          // Reclaim's onTlsEnd usually fires for clean close-notify, but
          // a raw transport EOF without an alert wouldn't trigger it.
          // Drive closePlain ourselves so the consumer's reader unsticks
          // when the transport simply hangs up.
          closePlain();
          return;
        }
        await tlsClient.handleReceivedBytes(value);
      }
    } catch (e) {
      if (!handshakeOk) handshakeReject(e);
      else closePlain(e);
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();

  if (opts.signal) {
    const captured = opts.signal;
    const onAbort = (): void => {
      const reason = signalAbortReason(captured);
      if (!handshakeOk) handshakeReject(reason);
      else closePlain(reason);
      void reader.cancel(reason).catch(() => {});
    };
    captured.addEventListener('abort', onAbort, { once: true });
    detachAbortListener = (): void => { captured.removeEventListener('abort', onAbort); };
    // addEventListener('abort') on an already-aborted signal does not fire,
    // so an abort that landed between the pre-check at the top of this
    // function and this listener install would otherwise be lost. Drive
    // onAbort synchronously to close that TOCTOU window.
    if (captured.aborted) onAbort();
  }

  try {
    await tlsClient.startHandshake();
    await handshakeDone;
  } catch (err) {
    cleanupSignal();
    // Handshake never completed: the reader still holds the transport.readable
    // lock and the writer holds transport.writable. Cancel both so the caller
    // can close the underlying socket cleanly without an orphaned stream lock.
    void reader.cancel(err).catch(() => {});
    try { writer.releaseLock(); } catch { /* lock already released */ }
    throw err;
  }

  return { readable: plainReadable, writable: plainWritable };
};

// Keep teardown errors visible at debug level — they're usually "peer
// already closed" but a real bug would otherwise be silenced. Gate behind
// an env flag so we don't log on hot paths where any console output is
// undesirable (e.g. inside a Worker request).
interface NodeProcessShape { env?: { DEBUG_USERSPACE_TLS?: string } }
const logTlsTeardownError = (e: unknown): void => {
  const proc = (globalThis as unknown as { process?: NodeProcessShape }).process;
  if (proc?.env?.DEBUG_USERSPACE_TLS) {
    console.debug('[userspace-tls] teardown:', e);
  }
};
