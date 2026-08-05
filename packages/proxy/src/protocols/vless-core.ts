// Shared VLESS core: write VLESS header to a transport, peel the server's
// reply prefix off the readable, and return the post-framing duplex stream.
// Callers must pass a transport whose framing/TLS is already established.

import { concat, copy, encodeAtypAddress, hexDecode } from '../bytes.ts';
import { ProxyDialError } from '../errors.ts';
import type { DialResult, DialTarget } from '../types.ts';

export const vlessFrameOverStream = async (
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  uuid: string,
  target: DialTarget,
): Promise<DialResult> => {
  const header = buildVlessHeader(uuid, target);
  const writer = transport.writable.getWriter();
  try {
    await writer.write(header);
  } finally {
    writer.releaseLock();
  }

  const stripped = stripVlessReplyPrefix(transport.readable);

  return { readable: stripped, writable: transport.writable };
};

/**
 * VLESS request header.
 *
 *   ver=0x00 | UUID[16] | addonsLen=0 | cmd=0x01 (TCP)
 *     | port[BE] | ATYP | addr | payload…
 *
 * ATYP values (xtls.github.io/development/protocols/vless.html):
 *   0x01 IPv4 (4 raw octets)
 *   0x02 Domain (1-byte length + domain bytes)
 *   0x03 IPv6 (16 raw octets)
 *
 * Note the numbering is distinct from SOCKS5 / Shadowsocks (which use
 * 0x01 v4, 0x03 domain, 0x04 v6) — confusing the two encodings is the
 * exact failure mode this builder discriminates against.
 */
const buildVlessHeader = (uuid: string, target: DialTarget): Uint8Array => {
  const uuidBytes = parseUuid(uuid);
  const addr = encodeAtypAddress(target.host, { v4: 0x01, domain: 0x02, v6: 0x03 });
  const header = new Uint8Array(1 + 16 + 1 + 0 + 1 + 2 + addr.byteLength);
  let off = 0;
  header[off++] = 0x00;
  header.set(uuidBytes, off); off += 16;
  header[off++] = 0x00;
  header[off++] = 0x01;
  header[off++] = (target.port >> 8) & 0xff;
  header[off++] = target.port & 0xff;
  header.set(addr, off);
  return header;
};

const parseUuid = (s: string): Uint8Array => {
  const hex = s.replace(/-/g, '');
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) {
    // UUIDs are VLESS credentials. Carry the raw value only on `cause`
    // so it stays out of the dial error's message, which callers
    // typically render verbatim into logs and error reports.
    throw new ProxyDialError('VLESS: malformed UUID', 'proxy-handshake', { cause: { uuid: s } });
  }
  return hexDecode(hex);
};

const stripVlessReplyPrefix = (source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  let stripped = false;
  let buf = new Uint8Array(0);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch { /* lock already released */ }
  };
  const fail = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: ProxyDialError,
  ): Promise<void> => {
    try { await reader.cancel(error); } catch { /* reader already cancelled */ } finally { release(); }
    controller.error(error);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!stripped) {
        while (buf.byteLength < 2) {
          const r = await reader.read();
          if (r.done) {
            await fail(controller, new ProxyDialError('VLESS reply: EOF before prefix', 'proxy-handshake'));
            return;
          }
          buf = concat(buf, r.value);
        }
        // Fail closed with a typed proxy-handshake error so non-VLESS
        // bytes never reach the payload stream and surface as an opaque
        // downstream failure.
        if (buf[0] !== 0x00) {
          await fail(controller, new ProxyDialError(`VLESS reply: bad version 0x${buf[0]!.toString(16)}`, 'proxy-handshake'));
          return;
        }
        const addonsLen = buf[1]!;
        while (buf.byteLength < 2 + addonsLen) {
          const r = await reader.read();
          if (r.done) {
            await fail(controller, new ProxyDialError('VLESS reply: EOF in addons', 'proxy-handshake'));
            return;
          }
          buf = concat(buf, r.value);
        }
        stripped = true;
        const remainder = copy(buf.subarray(2 + addonsLen));
        if (remainder.byteLength) {
          controller.enqueue(remainder);
          return;
        }
      }
      try {
        const r = await reader.read();
        if (r.done) {
          controller.close();
          release();
        } else {
          controller.enqueue(copy(r.value));
        }
      } catch (error) {
        release();
        throw error;
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } catch { /* reader already cancelled */ } finally { release(); }
    },
  });
};
