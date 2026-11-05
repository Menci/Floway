// Runtime-agnostic byte-stream dial primitive. Each runtime supplies a
// concrete impl via initSocketDial; callers obtain it via getSocketDial().

import type { DuplexStream } from '@floway-dev/http';

interface SocketDialOptions {
  /**
   * Wrap the connection with the runtime's native TLS implementation. The
   * hostname is reused as SNI and as the certificate-verify name.
   */
  tls?: boolean;
  /**
   * Caller-supplied cancellation. When the signal aborts:
   *   - mid-connect dials are torn down immediately;
   *   - established sockets are closed by the runtime impl, which then
   *     surfaces as read/write rejections on the returned streams.
   * The signal is also honoured pre-connect: a signal that is already
   * aborted at call time throws synchronously without opening a socket —
   * its Error reason is rethrown as-is, and a primitive or absent reason
   * becomes a DOMException('AbortError').
   */
  signal?: AbortSignal;
}

export interface DialedSocket {
  /** Reaches EOF when the peer sends FIN, independently of the writable side. */
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Idempotent close. */
  close(): Promise<void>;
}

export interface TlsUpgradeOptions {
  /**
   * TLS peer identity. DNS names are sent in the ClientHello `server_name`
   * extension; IP literals omit that extension (RFC 6066 §3). Also the
   * certificate reference identity unless `verifyHost` is set.
   */
  host: string;
  /**
   * Override the certificate reference identity independently from `host`.
   * An IP literal must match an `iPAddress` SAN. A DNS name matches `dNSName`
   * SANs; the userspace path also accepts a CN match, while Node ignores CN
   * once the certificate lists any DNS SAN. Defaults to `host`.
   */
  verifyHost?: string;
  /** ALPN protocols to offer, in preference order. */
  alpn?: string[];
  /**
   * Accept the peer certificate without chain validation or name matching.
   * For self-signed proxy leaves only.
   */
  insecure?: boolean;
  /**
   * Bytes to write to the transport before the handshake starts. Proxy
   * protocols whose request header precedes the tunneled TLS — trojan's —
   * need it to reach the peer ahead of the ClientHello; a userspace
   * implementation may additionally coalesce it into the first handshake
   * record.
   */
  prefix?: Uint8Array;
  /** Cancellation, honoured during and after the handshake. */
  signal?: AbortSignal;
}

export interface SocketDial {
  connect(host: string, port: number, opts?: SocketDialOptions): Promise<DialedSocket>;
  /**
   * Wrap an established duplex in TLS. Callers use it for every TLS leg that
   * follows a plaintext exchange — a proxy's outer leg where the protocol
   * needs one (trojan), the upstream's inner leg, an inner leg over an outer
   * one — so the runtime decides whether the handshake is native or
   * userspace. A dial can be plain TCP and still need TLS afterwards (HTTP
   * CONNECT, SOCKS5), which is why this is separate from `connect`. REALITY
   * builds its own ClientHello and never reaches this.
   */
  startTls(transport: DuplexStream, opts: TlsUpgradeOptions): Promise<DuplexStream>;
  /** Whether an error thrown by connect() permits retrying the HTTP request through runtime fetch. */
  shouldConnectErrorFallbackToFetch?(error: unknown): boolean;
}

let current: SocketDial | null = null;

export const initSocketDial = (impl: SocketDial): void => {
  current = impl;
};

export const getSocketDial = (): SocketDial => {
  if (!current) throw new Error('SocketDial not initialized');
  return current;
};

/** Test-only: clears the module singleton. */
export const resetSocketDialForTesting = (): void => {
  current = null;
};

/** Throws using the same policy described on SocketDialOptions.signal. */
export const throwAbort = (signal: AbortSignal): never => {
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(String(reason ?? 'aborted'), 'AbortError');
};

/**
 * WHATWG `URL.hostname` keeps the `[...]` envelope around IPv6 literals,
 * but runtime TCP APIs reject bracketed literals as ENOTFOUND.
 */
export const normalizeDialHost = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
