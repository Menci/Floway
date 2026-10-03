// Transport and request types for proxy dialing.
//
// The dial layer is transport-only. `DialTarget` describes WHERE to land
// after the proxy hop completes — host + port — and nothing else. TLS,
// SNI, ALPN, and HTTP-shaped concerns live one layer up in the
// orchestrator (runProxiedRequest).

/** Pure transport target: where the proxy should land us. */
export interface DialTarget {
  /**
   * TCP host the proxy should reach on our behalf. Can be a hostname (resolved
   * by the proxy's resolver) or a literal IPv4/IPv6 address.
   *
   * MUST be ASCII. Callers are responsible for punycoding IDN labels before
   * the dial layer sees them — the wire format for every proxy protocol we
   * support either frames the hostname as length-prefixed bytes (SOCKS-style
   * ATYP-domain for SOCKS5 / SS / SS2022 / Trojan / VLESS) or embeds it raw
   * in an ASCII request line (HTTP CONNECT); a raw UTF-8 IDN would muddle
   * Latin-1 / UTF-8 framing in the former and break the ASCII grammar in the
   * latter. Dialers reject non-ASCII hosts up-front with a typed dial error.
   *
   * IPv6 literals: pass the bare address without `[…]` brackets — the proxy
   * library does not normalise the envelope, and downstream Host-header synth
   * re-adds the brackets when pushing the host back into a uri-host context.
   * `URL#hostname` keeps the brackets on IPv6 literals, so callers building a
   * DialTarget from a parsed URL must strip them first.
   */
  host: string;
  /** TCP port. */
  port: number;
}

/**
 * Request-time target for the orchestrator: a DialTarget plus the
 * inner-TLS parameters needed to wrap the post-dial stream.
 *
 * Defaults flow `host → sni → verifyHost`. Override any one slot for
 * use cases like:
 *
 *   - **Domain fronting**: `host` and `sni` point at the front
 *     (e.g. a CDN edge), the HTTP request's `Host:` carries the real
 *     upstream name.
 *   - **Direct IP identity**: `host` is a literal IP; omitted `sni` and
 *     `verifyHost` make TLS omit `server_name` and verify its IP SAN.
 *   - **Dial-by-IP for a DNS identity**: `host` is a literal IP while `sni`
 *     and `verifyHost` are the certificate's hostname.
 *   - **SNI hiding**: `sni` is benign, `verifyHost` is internal.
 */
export interface ProxyRequestTarget extends DialTarget {
  /** Whether to wrap the post-proxy byte stream with TLS to the upstream. */
  tls: boolean;

  /**
   * TLS peer identity. DNS names are sent in the ClientHello `server_name`
   * extension; IP literals automatically omit that extension. Defaults to
   * `host`.
   */
  sni?: string;

  /**
   * Reference identity the upstream certificate chain must prove. IP
   * literals match only `iPAddress` SANs. Defaults to `sni` (which itself
   * defaults to `host`).
   */
  verifyHost?: string;

  /** Optional ALPN protocol list for the inner TLS handshake. */
  alpn?: string[];
}

export interface SocketDial {
  connect(host: string, port: number, opts?: SocketDialOptions): Promise<DialedSocket>;
}

export interface DialedSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Idempotent close. */
  close(): Promise<void>;
}

// Structurally identical to @floway-dev/platform's SocketDialOptions;
// duplicated rather than imported so @floway-dev/proxy stays runtime-
// agnostic and the platform's impl is assignable by structural typing.
export interface SocketDialOptions {
  tls?: boolean;
  signal?: AbortSignal;
}

/**
 * Output of a per-protocol `dial`. The duplex stream points at
 * `target.host:target.port` (after the proxy's framing has been peeled
 * off). `prefix`, when present, is bytes the dialer wants prepended to
 * the very first record the orchestrator emits next.
 */
export interface DialResult {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  prefix?: Uint8Array;
}

export interface DialOptions {
  /** Caller-supplied cancellation, threaded through every dial leg. */
  signal?: AbortSignal;
  /** Per-call dial-stage deadline override (ms). Falls back to
   *  DEFAULT_DIAL_DEADLINE_MS when absent. */
  dialTimeoutMs?: number;
  /**
   * Platform-injected byte-stream dial primitive: a `connect` that opens a
   * duplex to a host:port and can also wrap it in the runtime's native TLS.
   * Required — every dialer needs to open at least one connection.
   */
  socketDial: SocketDial;
}
