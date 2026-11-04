// Trojan client.
//
// The request header (56-byte hex(SHA-224(password)) + CRLF + SOCKS-like
// address) MUST land in the same TLS record as the first follow-up bytes from
// whichever wrapper consumes the post-trojan stream. sing-box's inbound reads
// the key with `conn.Read`, which returns at most one record, and short-reads
// reject with "bad request size" when no fallback is configured. We surface
// the header as `prefix` on the dial result so the next byte sink — the inner
// TLS handshake or the request writer — folds it into its own first write.
//
// That constraint also rules out a native TLS outer leg on workerd: its
// implementation splits the first application-data write across two records
// (~4 bytes then the rest), which is exactly the short read the inbound
// rejects. Node's TLS keeps a small write in a single record, so the outer
// and inner legs there run natively with the header delivered intact.
//
// Spec: https://trojan-gfw.github.io/trojan/protocol

import { sha224 } from '@noble/hashes/sha2.js';

import { encodeAtypAddress } from '../bytes.ts';
import { ProxyDialError } from '../dial-error.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { utf8Bytes } from '../encoding.ts';
import type { TrojanProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialedSocket, DialTarget } from '../types.ts';
import type { DuplexStream } from '@floway-dev/http';

export const dialTrojan = async (
  config: TrojanProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'Trojan');
  assertValidTargetHost(target.host, 'Trojan', { maxBytes: 255 });
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { signal: options.signal });

  try {
    return await dialTrojanInner(socket, config, target, options);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialTrojanInner = async (
  socket: DialedSocket,
  config: TrojanProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  let outerTls: DuplexStream;
  try {
    outerTls = await options.socketDial.startTls(socket, {
      host: config.sni ?? config.host,
      // Operator escape hatch for self-signed trojan-server leaves (the
      // trojan-go reference inbound runs self-signed by default); the
      // runtime chain-validates otherwise.
      insecure: config.allowInsecure,
      signal: options.signal,
    });
  } catch (cause) {
    throw new ProxyDialError('outer tls handshake to trojan server failed', 'outer-tls', { cause });
  }

  return {
    readable: outerTls.readable,
    writable: outerTls.writable,
    prefix: buildTrojanRequestHeader(config.password, target),
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
