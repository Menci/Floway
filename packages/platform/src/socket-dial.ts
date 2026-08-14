// Runtime-agnostic byte-stream dial primitive. Each runtime supplies a
// concrete impl via initSocketDial; callers obtain it via getSocketDial().

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

export interface SocketDial {
  connect(host: string, port: number, opts?: SocketDialOptions): Promise<DialedSocket>;
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
