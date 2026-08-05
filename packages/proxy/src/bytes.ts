// Byte ownership, encoding, HTTP head scanning, URI-host formatting, and
// SOCKS-style address framing for proxy dialing and request execution.
// Buffers read from a transport-owned ReadableStream may be pooled or reused
// by the runtime, so retained or downstream-enqueued bytes must own their memory.

import ipaddr from 'ipaddr.js';

/**
 * Allocate a fresh ArrayBuffer-backed Uint8Array detached from any
 * transport-owned backing storage so the consumer can hold or mutate it
 * safely.
 */
export const copy = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
};

/**
 * Format a `DialTarget.host` for embedding back into a uri-host context.
 * Per the `DialTarget.host` contract IPv6 literals arrive without `[…]`
 * brackets; RFC 3986 §3.2.2 requires the envelope whenever the host sits
 * next to a `:port` suffix or a colon-bearing context.
 */
export const formatHostForUri = (host: string): string =>
  host.includes(':') ? `[${host}]` : host;

/**
 * Concatenate two byte buffers into a freshly-allocated ArrayBuffer-backed
 * Uint8Array. The empty-input branches go through `copy()` so the returned
 * buffer is always detached from the inputs' backing storage — accumulators
 * (`buf = concat(buf, value)` starting from a zero-length buf) can therefore
 * hold the result past the next transport read without risking aliasing.
 */
export const concat = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (a.byteLength === 0) return copy(b);
  if (b.byteLength === 0) return copy(a);
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
};

/**
 * UTF-8-encode a string. Equivalent to `new TextEncoder().encode(s)` but
 * short enough to use inline without forcing each caller to keep its own
 * encoder around.
 */
export const utf8Bytes = (s: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

/** Fill a fresh `n`-byte buffer from the Web Crypto CSPRNG. */
export const randomBytes = (n: number): Uint8Array<ArrayBuffer> => {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
};

/**
 * Parse a hex string into bytes. Throws on odd length or any non-hex
 * character — `parseInt('zz', 16)` returns NaN which would otherwise
 * silently write the byte slot as 0 and let a typo through wire framing.
 */
export const hexDecode = (s: string): Uint8Array<ArrayBuffer> => {
  if (s.length % 2 !== 0) throw new Error(`hex: odd length ${s.length}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.byteLength; i++) {
    const hi = hexNibble(s.charCodeAt(i * 2));
    const lo = hexNibble(s.charCodeAt(i * 2 + 1));
    out[i] = (hi << 4) | lo;
  }
  return out;
};

const hexNibble = (code: number): number => {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;       // '0'..'9'
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;  // 'a'..'f'
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;  // 'A'..'F'
  throw new Error(`hex: non-hex character 0x${code.toString(16)}`);
};

/**
 * Locate a CR/LF/CR/LF sequence — the HTTP/1.1 header-section terminator
 * (RFC 9112 §2.2). Returns the index of the first CR, or -1 if the buffer
 * doesn't contain a full terminator yet.
 *
 * The `from` resume index lets a drip-fed accumulator avoid rescanning
 * the prefix on every read: a caller that already searched up to
 * `buf.byteLength` then concats more bytes can pass
 * `Math.max(0, prevByteLength - 3)` to re-examine only the tail where a
 * partial terminator could have started straddling the seam. Without it
 * the per-read search is O(n) on the whole buffer, turning a 1-byte
 * drip up to the 64 KiB header cap into O(n²).
 */
export const findDoubleCrlfFrom = (buf: Uint8Array, from: number): number => {
  for (let i = from; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
};

/**
 * Base64-encode a raw byte buffer. RFC 7617 §2.1 mandates UTF-8 bytes for
 * HTTP Basic auth credentials: the caller encodes the credential string to
 * UTF-8 with TextEncoder, then base64s those bytes (NOT the JS string code
 * units of the original credentials, which would emit Latin-1 bytes and
 * crash on code points > U+00FF). `btoa` requires a binary-string input
 * (one code-unit per byte), so we map each byte to its corresponding
 * Latin-1 code unit via `String.fromCharCode` before calling btoa.
 */
export const base64EncodeBytes = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};

/**
 * Base64-decode the inverse of {@link base64EncodeBytes}. `atob` returns
 * a Latin-1 binary string; map each code unit back to its byte value.
 * Throws (via `atob`) on invalid base64.
 */
export const base64DecodeBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

type IpLiteral =
  | { kind: 'ipv4'; bytes: Uint8Array<ArrayBuffer> }
  | { kind: 'ipv6'; bytes: Uint8Array<ArrayBuffer> };

/**
 * Parse a canonical wire-safe IP literal. IPv4 remains restricted to four
 * decimal components without leading zeroes: ipaddr.js intentionally accepts
 * historical short, octal, and hexadecimal forms through its general parser,
 * while proxy targets must not reinterpret those resolver-dependent strings.
 * IPv6 zone IDs identify a local interface rather than an address that can be
 * carried meaningfully to a remote proxy, so they stay on the domain path.
 */
const parseIpLiteral = (host: string): IpLiteral | null => {
  if (ipaddr.IPv4.isValidFourPartDecimal(host)) {
    return {
      kind: 'ipv4',
      bytes: Uint8Array.from(ipaddr.IPv4.parse(host).toByteArray()),
    };
  }

  if (host.includes('%') || !ipaddr.IPv6.isValid(host)) return null;

  // ipaddr.js accepts the same historical IPv4 spellings in an IPv6
  // transitional tail. Keep the tail aligned with the strict IPv4 contract.
  let ipv6Host = host;
  if (host.includes('.')) {
    const ipv4Tail = host.slice(host.lastIndexOf(':') + 1);
    if (!ipaddr.IPv4.isValidFourPartDecimal(ipv4Tail)) return null;

    // ipaddr.js treats bare IPv4-compatible `::192.0.2.128` as the
    // IPv4-mapped `::ffff:192.0.2.128`. Turn an already-validated dotted tail
    // into its two native IPv6 groups first so compatible and mapped forms
    // retain their distinct wire bits.
    const [a, b, c, d] = ipaddr.IPv4.parse(ipv4Tail).toByteArray();
    const ipv6Prefix = host.slice(0, host.lastIndexOf(':') + 1);
    ipv6Host = `${ipv6Prefix}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }

  return {
    kind: 'ipv6',
    bytes: Uint8Array.from(ipaddr.IPv6.parse(ipv6Host).toByteArray()),
  };
};

/**
 * ATYP byte triplet for a proxy protocol's SOCKS-style address frame.
 * SOCKS-style protocols disagree on the v4/domain/v6 numbering, so the
 * dialers thread their own values into `encodeAtypAddress` and the IP-
 * literal vs. domain discrimination stays in one place.
 */
interface AtypBytes {
  v4: number;
  domain: number;
  v6: number;
}

/**
 * Encode `host` as `[ATYP][addr-bytes]` for a SOCKS-style proxy frame.
 *
 * Literal IPv4 / IPv6 targets emit raw octets (4 / 16 bytes) so the
 * upstream doesn't have to re-parse a string into an address — the wire
 * shape sing-box / Xray-core / shadowsocks-rust all send for literal
 * targets. Domain hostnames take the length-prefixed `0x03`/`0x02` path;
 * callers contractually pre-assert ASCII and the 255-byte cap via
 * `assertValidTargetHost(host, '<protocol>', { maxBytes: 255 })` before
 * we get here, so the domain branch can encode unconditionally.
 */
export const encodeAtypAddress = (
  host: string,
  atyp: AtypBytes,
): Uint8Array<ArrayBuffer> => {
  const literal = parseIpLiteral(host);
  if (literal) {
    const out = new Uint8Array(1 + literal.bytes.byteLength);
    out[0] = literal.kind === 'ipv4' ? atyp.v4 : atyp.v6;
    out.set(literal.bytes, 1);
    return out;
  }
  const dom = utf8Bytes(host);
  const out = new Uint8Array(1 + 1 + dom.byteLength);
  out[0] = atyp.domain;
  out[1] = dom.byteLength;
  out.set(dom, 2);
  return out;
};
