// Trojan client.
//
// We do BOTH the outer TLS (to the Trojan server) and the inner TLS (to the
// upstream HTTPS) in userspace, because workerd's outer TLS implementation
// splits the first application-data write into two TLS records (~4 bytes +
// rest). sing-box's trojan inbound reads the 56-byte key with `conn.Read`,
// which short-reads on the 4-byte first record and rejects with
// "bad request size: fallback disabled". Doing the outer TLS in userspace
// gives us full control of record framing.
//
// The Trojan request header (56-byte hex(SHA-224(password)) + CRLF + SOCKS-
// like address) MUST land in the same record as the first follow-up bytes
// from whichever wrapper consumes the post-trojan stream. We surface the
// header as `prefix` on the DialResult so whoever owns the next write
// folds it in.

import { sha224 } from '@noble/hashes/sha2.js';

import { encodeAtypAddress, utf8Bytes } from '../bytes.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { ProxyDialError } from '../errors.ts';
import type { TrojanProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { userspaceTls, type TlsStream } from '@floway-dev/http';

export const dialTrojan = async (
  config: TrojanProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'Trojan');
  assertValidTargetHost(target.host, 'Trojan', { maxBytes: 255 });
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { signal: options.signal });

  try {
    return await dialTrojanInner(socket, config, target, options.signal);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialTrojanInner = async (
  socket: DialedSocket,
  config: TrojanProxyConfig,
  target: DialTarget,
  signal: AbortSignal | undefined,
): Promise<DialResult> => {
  let outerTls: TlsStream;
  try {
    outerTls = await userspaceTls(socket, {
      host: config.sni ?? config.host,
      // Operator escape hatch for self-signed trojan-server leaves (the
      // trojan-go reference inbound runs self-signed by default); the
      // wrapper chain-validates otherwise.
      insecure: config.allowInsecure,
      signal,
    });
  } catch (cause) {
    throw new ProxyDialError('outer tls handshake to trojan server failed', 'outer-tls', { cause });
  }

  const header = buildTrojanRequestHeader(config.password, target);

  return {
    readable: outerTls.readable,
    writable: outerTls.writable,
    prefix: header,
  };
};

/**
 * Trojan request header.
 *
 *   hex(SHA-224(password))[56] | CRLF | CMD=0x01 | ATYP | addr | port[BE] | CRLF
 *
 * ATYP follows the SOCKS5 numbering (0x01 IPv4 raw, 0x03 domain
 * length-prefixed, 0x04 IPv6 raw).
 *
 * Spec: https://trojan-gfw.github.io/trojan/protocol
 */
export const buildTrojanRequestHeader = (password: string, target: DialTarget): Uint8Array => {
  assertValidTargetPort(target.port, 'Trojan');
  const hash = sha224(utf8Bytes(password));

  const addr = encodeAtypAddress(target.host, { v4: 0x01, domain: 0x03, v6: 0x04 });
  const header = new Uint8Array(56 + 2 + 1 + addr.byteLength + 2 + 2);
  let off = 0;
  for (let i = 0; i < hash.byteLength; i++) {
    const b = hash[i]!;
    header[off++] = HEX_CHARS[b >> 4]!;
    header[off++] = HEX_CHARS[b & 0xf]!;
  }
  header[off++] = 0x0d; header[off++] = 0x0a;
  header[off++] = 0x01;
  header.set(addr, off); off += addr.byteLength;
  header[off++] = (target.port >> 8) & 0xff;
  header[off++] = target.port & 0xff;
  header[off++] = 0x0d; header[off++] = 0x0a;
  return header;
};

const HEX_CHARS = new Uint8Array([
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
  0x38, 0x39, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66,
]);
