import { ProxyDialError } from './errors.ts';
import type { DialedSocket, SocketDial, SocketDialOptions } from './types.ts';

/**
 * Reject a port outside the 1..65535 range used by TCP. Port 0 is
 * reserved (RFC 6335 §6) — its presence on the wire is almost always
 * a config bug. We surface a typed dial error at stage 'config' before
 * any I/O so the fallback chain can advance to the next proxy entry
 * without burning a TCP slot. */
export const assertValidTargetPort = (port: number, protocol: string): void => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyDialError(`${protocol}: target port must be 1..65535, got ${port}`, 'config');
  }
};

/**
 * Enforce the `DialTarget.host` ASCII + non-empty contract before any I/O.
 * Also reject the C0 control set (NUL, CR, LF, the rest of 0x00-0x1F),
 * SP, and DEL: a host containing one of those bytes that flows into the
 * HTTP CONNECT request line as `${target.host}:${target.port}` would
 * split the request line and inject a forged head onto the wire. Length-
 * prefixed dialers are not exposed to that smuggling shape, but
 * centralizing the byte filter here lets every dialer inherit the same
 * defense.
 *
 * SOCKS-style ATYP-domain framing carries the host as a 1-byte length-
 * prefix + bytes, so callers wiring those protocols pass `maxBytes: 255`.
 * Rejecting here surfaces as 'config' before any TCP slot is burned,
 * instead of masquerading mid-dial as a proxy-handshake error on an empty
 * length-prefixed domain, an over-long domain, or a `CONNECT :PORT`
 * request line. */
export const assertValidTargetHost = (
  host: string,
  protocol: string,
  opts?: { maxBytes?: number },
): void => {
  if (host.length === 0) {
    throw new ProxyDialError(`${protocol}: target host is empty`, 'config');
  }
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    if (c > 0x7f) {
      throw new ProxyDialError(
        `${protocol}: target host must be ASCII (punycode IDN before dial): ${host}`,
        'config',
      );
    }
    if (c < 0x21 || c === 0x7f) {
      throw new ProxyDialError(
        `${protocol}: target host contains a forbidden byte 0x${c.toString(16).padStart(2, '0')}`,
        'config',
      );
    }
  }
  // ASCII-only above guarantees 1-byte-per-char UTF-8, so host.length is
  // both the char count and the encoded byte count.
  if (opts?.maxBytes !== undefined && host.length > opts.maxBytes) {
    throw new ProxyDialError(
      `${protocol}: target host too long (${host.length} bytes; ATYP domain is 1-byte length-prefixed, max ${opts.maxBytes})`,
      'config',
    );
  }
};

/**
 * Open a TCP socket and rewrap any failure as a typed `tcp-connect`
 * ProxyDialError. Every dialer's outer `socket = await socketDial.connect(…)`
 * needs the same wrap so the fallback chain sees a uniform discriminant —
 * this is that wrap, centralised.
 */
export const connectOrDialError = async (
  socketDial: SocketDial,
  host: string,
  port: number,
  opts?: SocketDialOptions,
): Promise<DialedSocket> => {
  try {
    return await socketDial.connect(host, port, opts);
  } catch (cause) {
    throw new ProxyDialError(`tcp connect to ${host}:${port} failed`, 'tcp-connect', { cause });
  }
};
