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
import { cleanupFailure, collectCleanupFailures, failureWithCleanup } from './cleanup.ts';
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
   * TLS ClientHello server_name extension and (unless `verifyHost` is set)
   * the hostname against which the cert chain is validated.
   */
  host: string;
  /**
   * Override the cert-validation hostname independently from `host` (the
   * SNI). The cert's SAN/CN must prove this name. Defaults to `host`.
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
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = transport.readable.getReader();
  } catch (error) {
    const cleanupFailures = await collectCleanupFailures([() => writer.releaseLock()]);
    throw failureWithCleanup(error, cleanupFailures, 'TLS reader acquisition and writer cleanup both failed');
  }

  const defer = <T>(operation: () => Promise<T>): Promise<T> => Promise.resolve().then(operation);
  let readerReleased = false;
  let readerFailed = false;
  let readerDone = false;
  const readTransport = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    try {
      return await reader.read();
    } catch (error) {
      readerFailed = true;
      throw error;
    }
  };
  const releaseReader = (): void => {
    if (readerReleased) return;
    reader.releaseLock();
    readerReleased = true;
  };
  let readerSettlement: Promise<readonly unknown[]> | null = null;
  const settleReader = (reason: unknown): Promise<readonly unknown[]> => {
    readerSettlement ??= defer(async () => await collectCleanupFailures([
      ...(!readerFailed && !readerDone ? [async () => await reader.cancel(reason)] : []),
      releaseReader,
    ]));
    return readerSettlement;
  };

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
  const pendingPlaintext: Uint8Array<ArrayBuffer>[] = [];
  let cleanClosePending = false;
  let resumeDemand: (() => void) | null = null;

  let transportWrites = Promise.resolve();
  let writerFailed = false;
  const queueTransportWrite = (bytes: Uint8Array): void => {
    transportWrites = transportWrites.then(async () => await writer.write(bytes));
    transportWrites.catch(error => {
      writerFailed = true;
      if (!handshakeOk) handshakeReject(error);
      void terminate({
        type: 'failure',
        primary: error,
        endTls: false,
        writer: 'abort',
        message: 'TLS transport write and cleanup both failed',
      });
    });
  };

  let writerReleased = false;
  const releaseWriter = (): void => {
    if (writerReleased) return;
    writer.releaseLock();
    writerReleased = true;
  };
  let writerSettlement: Promise<readonly unknown[]> | null = null;
  const settleWriter = (mode: 'close' | 'abort', reason: unknown): Promise<readonly unknown[]> => {
    writerSettlement ??= defer(async () => await collectCleanupFailures([
      ...(writerFailed
        ? []
        : [async () => {
            if (mode === 'abort') await writer.abort(reason);
            else await writer.close();
          }]),
      releaseWriter,
    ]));
    return writerSettlement;
  };

  type TerminalOutcome =
    | { readonly type: 'ok'; readonly cleanupFailures: readonly unknown[] }
    | { readonly type: 'error'; readonly error: unknown; readonly cleanupFailures: readonly unknown[] };
  type TerminalIntent =
    | {
      readonly type: 'failure';
      readonly primary: unknown;
      readonly endTls: boolean;
      readonly writer: 'abort';
      readonly message: string;
    }
    | {
      readonly type: 'clean';
      readonly endTls: boolean;
      readonly writer: 'close';
      readonly message: string;
    }
    | {
      readonly type: 'cancel';
      readonly reason: unknown;
      readonly endTls: boolean;
      readonly writer: 'close' | 'abort';
      readonly message: string;
    };
  let terminal: Promise<TerminalOutcome> | null = null;
  const currentTerminal = (): Promise<TerminalOutcome> | null => terminal;

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

  const drainPlaintext = (): void => {
    try {
      while (pendingPlaintext.length > 0 && (plainController.desiredSize ?? 0) > 0) {
        plainController.enqueue(pendingPlaintext.shift()!);
      }
      if (cleanClosePending && pendingPlaintext.length === 0) {
        cleanClosePending = false;
        plainController.close();
      }
    } catch (error) {
      void terminate({
        type: 'failure',
        primary: error,
        endTls: true,
        writer: 'abort',
        message: 'TLS plaintext delivery and cleanup both failed',
      });
    }
  };

  const waitForPlainDemand = async (): Promise<void> => {
    if (!handshakeOk || plainClosed || (plainController.desiredSize ?? 0) > 0) return;
    await new Promise<void>(resolve => { resumeDemand = resolve; });
  };

  let pendingPrefix: Uint8Array | null = opts.prefix ? copy(opts.prefix) : null;

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
      queueTransportWrite(out);
    },
    onHandshake() {
      handshakeOk = true;
      handshakeResolve();
    },
    onApplicationData(plaintext) {
      if (plainClosed) return;
      pendingPlaintext.push(copy(plaintext));
      drainPlaintext();
    },
    onTlsEnd(error) {
      if (!handshakeOk) {
        const primary = error ?? new Error('TLS ended before handshake');
        handshakeReject(primary);
        void terminate({
          type: 'failure',
          primary,
          endTls: false,
          writer: 'abort',
          message: 'TLS handshake and cleanup both failed',
        });
        return;
      }
      if (error === undefined) {
        void terminate({
          type: 'clean',
          endTls: false,
          writer: 'close',
          message: 'TLS close cleanup failed',
        });
      } else {
        void terminate({
          type: 'failure',
          primary: error,
          endTls: false,
          writer: 'abort',
          message: 'TLS failure and cleanup both failed',
        });
      }
    },
  };

  const terminate = (intent: TerminalIntent): Promise<TerminalOutcome> => {
    if (terminal !== null) return terminal;
    plainClosed = true;
    cleanupSignal();
    resumeDemand?.();
    resumeDemand = null;
    terminal = defer(async () => {
      const reason = intent.type === 'failure'
        ? intent.primary
        : intent.type === 'cancel'
          ? intent.reason
          : undefined;
      const [tlsAndWriteFailures, readerFailures, writerFailures] = await Promise.all([
        collectCleanupFailures([
          ...(intent.endTls ? [async () => await tlsClient.end()] : []),
          async () => await transportWrites,
        ]),
        settleReader(reason),
        settleWriter(intent.writer, reason),
      ]);
      const cleanupFailures = [
        ...tlsAndWriteFailures,
        ...readerFailures,
        ...writerFailures,
      ].filter(error => intent.type !== 'failure' || !Object.is(error, intent.primary));
      const failed = intent.type === 'failure' || cleanupFailures.length > 0;
      if (failed) {
        const error = intent.type === 'failure'
          ? failureWithCleanup(intent.primary, cleanupFailures, intent.message)
          : cleanupFailure(cleanupFailures, intent.message);
        pendingPlaintext.length = 0;
        if (intent.type !== 'cancel') {
          try { plainController.error(error); } catch { /* consumer already cancelled */ }
        }
        return { type: 'error', error, cleanupFailures };
      }
      if (intent.type === 'clean') {
        cleanClosePending = true;
        drainPlaintext();
      }
      return { type: 'ok', cleanupFailures };
    });
    return terminal;
  };

  const tlsClient = makeTLSClient(tlsOptions as Parameters<typeof makeTLSClient>[0]);

  // App-data downward stream (TLS plaintext → consumer). The cancel hook
  // fires only after the duplex pair has been returned to the consumer,
  // so by then tlsClient is fully initialized.
  const plainReadable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c; },
    pull() {
      drainPlaintext();
      resumeDemand?.();
      resumeDemand = null;
    },
    // Consumer-initiated cancel (response body fully read or aborted) tears
    // down our side of the duplex. An Error reason hard-aborts the writer;
    // a clean cancel emits a polite FIN. The cancellation reason is metadata,
    // so only cleanup failures reject the cancel operation.
    async cancel(reason) {
      const outcome = await terminate({
        type: 'cancel',
        reason,
        endTls: true,
        writer: reason instanceof Error ? 'abort' : 'close',
        message: 'TLS readable cancellation cleanup failed',
      });
      if (outcome.type === 'error') throw outcome.error;
    },
  });

  // App-data upward stream (consumer → TLS encrypt → transport). Same
  // post-return invariant applies — write/close/abort run only after the
  // handshake await resolves and the duplex pair is handed back.
  const plainWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await tlsClient.write(chunk);
        await transportWrites;
      } catch (error) {
        const outcome = await terminate({
          type: 'failure',
          primary: error,
          endTls: true,
          writer: 'abort',
          message: 'TLS application write and cleanup both failed',
        });
        throw outcome.type === 'error' ? outcome.error : error;
      }
    },
    async close() {
      const outcome = await terminate({
        type: 'clean',
        endTls: true,
        writer: 'close',
        message: 'TLS writable close cleanup failed',
      });
      if (outcome.type === 'error') throw outcome.error;
    },
    async abort(reason) {
      const outcome = await terminate({
        type: 'cancel',
        reason,
        endTls: true,
        writer: 'abort',
        message: 'TLS writable abort cleanup failed',
      });
      if (outcome.type === 'error') throw outcome.error;
    },
  });

  // Pump bytes from transport → tls.handleReceivedBytes. Errors and
  // teardown are handled inside the IIFE; the outer flow only awaits the
  // handshake, so the pump's promise is intentionally not awaited.
  void (async () => {
    try {
      while (true) {
        const { value, done } = await readTransport();
        if (done) {
          readerDone = true;
          const pendingTerminal = currentTerminal();
          if (pendingTerminal !== null) {
            await pendingTerminal;
            return;
          }
          if (!handshakeOk) {
            const primary = new Error('TLS ended before handshake');
            handshakeReject(primary);
            await terminate({
              type: 'failure',
              primary,
              endTls: true,
              writer: 'abort',
              message: 'TLS handshake and cleanup both failed',
            });
            return;
          }
          // Reclaim's onTlsEnd usually fires for clean close-notify, but
          // a raw transport EOF without an alert wouldn't trigger it.
          // Drive the terminal coordinator ourselves so the consumer's reader
          // unsticks when the transport simply hangs up.
          await terminate({
            type: 'clean',
            endTls: true,
            writer: 'close',
            message: 'TLS EOF cleanup failed',
          });
          return;
        }
        await tlsClient.handleReceivedBytes(value);
        const pendingTerminal = currentTerminal();
        if (pendingTerminal !== null) {
          await pendingTerminal;
          return;
        }
        await waitForPlainDemand();
      }
    } catch (e) {
      if (!handshakeOk) handshakeReject(e);
      await terminate({
        type: 'failure',
        primary: e,
        endTls: false,
        writer: 'abort',
        message: handshakeOk ? 'TLS read and cleanup both failed' : 'TLS handshake and cleanup both failed',
      });
    }
  })();

  if (opts.signal) {
    const captured = opts.signal;
    const onAbort = (): void => {
      const reason = signalAbortReason(captured);
      if (!handshakeOk) handshakeReject(reason);
      void terminate({
        type: 'failure',
        primary: reason,
        endTls: true,
        writer: 'abort',
        message: handshakeOk ? 'TLS abort and cleanup both failed' : 'TLS handshake abort and cleanup both failed',
      });
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
    const startAndWrites = tlsClient.startHandshake().then(async () => await transportWrites);
    await Promise.all([startAndWrites, handshakeDone]);
  } catch (err) {
    const outcome = await terminate({
      type: 'failure',
      primary: err,
      endTls: true,
      writer: 'abort',
      message: 'TLS handshake and cleanup both failed',
    });
    throw outcome.type === 'error' ? outcome.error : err;
  }

  const pendingTerminal = currentTerminal();
  if (pendingTerminal !== null) {
    const outcome = await pendingTerminal;
    if (outcome.type === 'error') throw outcome.error;
  }

  return { readable: plainReadable, writable: plainWritable };
};
