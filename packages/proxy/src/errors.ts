// Surfaced by every protocol runner when the dial / proxy-handshake /
// inner-TLS handshake fails — i.e. when the upstream server has not
// observed any byte of our request yet.
//
// Anything thrown after the upstream sees our request is NOT a
// ProxyDialError — that's the upstream's problem.
//
// Stage taxonomy:
//   'config'           — wire-shape config validation rejected the entry
//                        before any I/O (bad base64, bad PSK length, port
//                        out of 1..65535, …). No TCP slot was burned.
//   'tcp-connect'      — TCP-level connect to the proxy / direct upstream
//                        failed (refused, unreachable, deadline).
//   'outer-tls'        — userspace TLS handshake to the proxy itself failed
//                        (Trojan / REALITY outer leg). The proxy server saw
//                        a TLS attempt but rejected it.
//   'proxy-handshake'  — proxy spoke its protocol back but framed a refusal
//                        (CONNECT 4xx, SOCKS5 reply error, SS / SS2022 /
//                        VLESS bad reply, REALITY HMAC mismatch).
//   'inner-tls'        — userspace TLS handshake to the upstream over the
//                        proxy's post-handshake stream failed.

export class ProxyDialError extends Error {
  override readonly name = 'ProxyDialError';
  private _requestMayHaveBeenSent = false;

  constructor(
    message: string,
    /** Where in the dial path the failure happened. */
    readonly stage:
      | 'config'
      | 'tcp-connect'
      | 'outer-tls'
      | 'proxy-handshake'
      | 'inner-tls',
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }

  get requestMayHaveBeenSent(): boolean {
    return this._requestMayHaveBeenSent;
  }

  markRequestMayHaveBeenSent(): this {
    this._requestMayHaveBeenSent = true;
    return this;
  }
}

/**
 * URI parser failures. Distinct from `ProxyDialError` because URI parsing
 * runs ahead of any dial — there is no stage taxonomy that applies.
 */
export class ProxyUriError extends Error {
  override readonly name = 'ProxyUriError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
