// Shadowsocks 2022 dialer (SIP022).
//
// Spec: https://github.com/shadowsocks/shadowsocks-org/blob/main/docs/doc/sip022.md
//
// Differences from AEAD-2018:
//   - PSK is the raw decoded key bytes (no EVP_BytesToKey).
//   - Subkey: BLAKE3.derive_key("shadowsocks 2022 session subkey", PSK||salt)
//   - TCP request format prepended with a fixed 11-byte fixed header
//     (type|timestamp(u64be)|len(u16be)) and a variable header
//     (ATYP|addr|port|padlen(u16be)|pad|initial_payload).
//   - TCP response: server echoes the request salt and includes a fresh
//     timestamp (must be within 30s of now).

import { blake3 } from '@noble/hashes/blake3.js';

import { base64DecodeBytes, concat, encodeAtypAddress, randomBytes, utf8Bytes } from '../bytes.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { ProxyDialError } from '../errors.ts';
import { makeExactReader } from '../exact-reader.ts';
import type { Shadowsocks2022ProxyConfig, Ss2022Method } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { type Aead, leNonce, makeAead } from './shadowsocks-aead.ts';

const KEY_LEN_2022: Record<Ss2022Method, number> = {
  '2022-blake3-aes-128-gcm': 16,
  '2022-blake3-aes-256-gcm': 32,
  '2022-blake3-chacha20-poly1305': 32,
};

const TAG = 16;
// SIP022 uses a u16 length field. Servers can send up to 0xffff per record;
// AEAD-2018's 0x3fff limit does not apply.
const MAX = 0xffff;
const SUBKEY_CONTEXT_BYTES = utf8Bytes('shadowsocks 2022 session subkey');

const REQ_HEADER_TYPE = 0x00;
const RESP_HEADER_TYPE = 0x01;

export const dialShadowsocks2022 = async (
  config: Shadowsocks2022ProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'SS2022');
  assertValidTargetHost(target.host, 'SS2022', { maxBytes: 255 });
  const keyLen = KEY_LEN_2022[config.method];
  let psk: Uint8Array<ArrayBuffer>;
  try {
    psk = base64DecodeBytes(config.passwordBase64);
  } catch (cause) {
    throw new ProxyDialError('SS2022: invalid base64 in PSK', 'config', { cause });
  }
  // PSK byte-length is part of the SIP022 wire contract: a key shorter or
  // longer than the cipher demands derives a wrong subkey and the very first
  // record fails AEAD auth.
  if (psk.byteLength !== keyLen) {
    throw new ProxyDialError(
      `SS2022: PSK is ${psk.byteLength} bytes, expected ${keyLen}`,
      'config',
    );
  }

  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { signal: options.signal });

  try {
    return await dialShadowsocks2022Inner(socket, config.method, psk, keyLen, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialShadowsocks2022Inner = async (
  socket: DialedSocket,
  method: Ss2022Method,
  psk: Uint8Array,
  keyLen: number,
  target: DialTarget,
): Promise<DialResult> => {
  const aeadKind = method === '2022-blake3-chacha20-poly1305' ? 'chacha' : 'gcm';
  const sendSalt = randomBytes(keyLen);
  const sendKey = blake3(concat(psk, sendSalt), { dkLen: keyLen, context: SUBKEY_CONTEXT_BYTES });
  const sendCipher = makeAead(aeadKind, sendKey);
  let sendNonce = 0n;
  let recvCipher: Aead | null = null;
  let recvNonce = 0n;

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const readN = makeExactReader(reader, 'SS2022');

  // Build the request:
  //   - sendSalt
  //   - fixed header AEAD: [type=0x00 | timestamp(u64be) | len(u16be)] + tag
  //     where len = byte length of the variable header (excluding tag).
  //   - variable header AEAD: [ATYP|addr|port|padlen(u16be)|pad|initial_payload] + tag
  const variableHeader = buildSs2022RequestHeader(target.host, target.port);
  const fixedPlain = new Uint8Array(1 + 8 + 2);
  fixedPlain[0] = REQ_HEADER_TYPE;
  new DataView(fixedPlain.buffer, fixedPlain.byteOffset, fixedPlain.byteLength).setBigUint64(1, BigInt(Math.floor(Date.now() / 1000)), false);
  fixedPlain[9] = (variableHeader.byteLength >> 8) & 0xff;
  fixedPlain[10] = variableHeader.byteLength & 0xff;

  const fixedSealed = sendCipher.encrypt(leNonce(sendNonce++), fixedPlain);
  const variableSealed = sendCipher.encrypt(leNonce(sendNonce++), variableHeader);
  const initialOut = new Uint8Array(sendSalt.byteLength + fixedSealed.byteLength + variableSealed.byteLength);
  initialOut.set(sendSalt, 0);
  initialOut.set(fixedSealed, sendSalt.byteLength);
  initialOut.set(variableSealed, sendSalt.byteLength + fixedSealed.byteLength);
  await writer.write(initialOut);
  writer.releaseLock();

  // AEAD auth failure on the very first frame is overwhelmingly a wrong-
  // password / wrong-cipher misconfig, so tag it as `proxy-handshake`
  // rather than letting a raw decrypt error surface.
  let recvBootstrapped = false;
  const ssReadable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!recvCipher) {
          const recvSalt = await readN(keyLen);
          const recvKey = blake3(concat(psk, recvSalt), { dkLen: keyLen, context: SUBKEY_CONTEXT_BYTES });
          recvCipher = makeAead(aeadKind, recvKey);
          // Read response fixed header AEAD: [type=0x01 | timestamp(u64be) | salt-echo(keyLen) | len(u16be)] + tag
          const respFixedSealed = await readN(1 + 8 + keyLen + 2 + TAG);
          const respFixedPlain = recvCipher.decrypt(leNonce(recvNonce++), respFixedSealed);
          if (respFixedPlain[0] !== RESP_HEADER_TYPE) {
            throw new ProxyDialError(`SS2022: bad response type ${respFixedPlain[0]}`, 'proxy-handshake');
          }
          // SIP022's replay defense rests on TWO checks: the salt-echo
          // (binds the response to our specific request) AND the
          // timestamp window (rejects a recorded-and-replayed response
          // outside the spec's 30-second window). Skipping the window
          // would weaken our SIP022 connection to AEAD-2018-like strength.
          //
          // The window is symmetric — the spec says "Messages with over
          // 30 seconds of time difference MUST be treated as replay" —
          // and shadowsocks-rust enforces it via `now.abs_diff(ts) > 30`
          // (crates/shadowsocks/src/relay/tcprelay/aead_2022.rs and
          // SERVER_STREAM_TIMESTAMP_MAX_DIFF=30 in proxy_stream/protocol/v2.rs).
          let respTs = 0n;
          for (let i = 0; i < 8; i++) respTs = (respTs << 8n) | BigInt(respFixedPlain[1 + i]!);
          const nowSec = BigInt(Math.floor(Date.now() / 1000));
          const skew = nowSec - respTs;
          if (skew > 30n || skew < -30n) {
            throw new ProxyDialError(`SS2022: response timestamp skew ${skew}s outside ±30s window`, 'proxy-handshake');
          }
          const echoStart = 1 + 8;
          for (let i = 0; i < keyLen; i++) {
            if (respFixedPlain[echoStart + i] !== sendSalt[i]) {
              throw new ProxyDialError('SS2022: salt-echo mismatch', 'proxy-handshake');
            }
          }
          const firstLen = (respFixedPlain[1 + 8 + keyLen]! << 8) | respFixedPlain[1 + 8 + keyLen + 1]!;
          const firstSealed = await readN(firstLen + TAG);
          const firstPlain = recvCipher.decrypt(leNonce(recvNonce++), firstSealed);
          recvBootstrapped = true;
          if (firstPlain.byteLength) controller.enqueue(firstPlain as Uint8Array<ArrayBuffer>);
          return;
        }
        const lenSealed = await readN(2 + TAG);
        const lenPlain = recvCipher.decrypt(leNonce(recvNonce++), lenSealed);
        const len = (lenPlain[0]! << 8) | lenPlain[1]!;
        if (len === 0) {
          controller.error(new ProxyDialError('SS2022: zero-length payload', 'proxy-handshake'));
          return;
        }
        const ptSealed = await readN(len + TAG);
        const pt = recvCipher.decrypt(leNonce(recvNonce++), ptSealed);
        controller.enqueue(pt as Uint8Array<ArrayBuffer>);
      } catch (e) {
        if (!recvBootstrapped && !(e instanceof ProxyDialError)) {
          controller.error(new ProxyDialError(`SS2022 handshake decrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'proxy-handshake', { cause: e }));
          return;
        }
        controller.error(e);
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => {}); },
  });

  const ssWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const w = socket.writable.getWriter();
      try {
        let off = 0;
        while (off < chunk.byteLength) {
          const piece = chunk.subarray(off, Math.min(off + MAX, chunk.byteLength));
          const lenBytes = new Uint8Array([(piece.byteLength >> 8) & 0xff, piece.byteLength & 0xff]);
          const lenSealed = sendCipher.encrypt(leNonce(sendNonce++), lenBytes);
          const ptSealed = sendCipher.encrypt(leNonce(sendNonce++), piece);
          await w.write(concat(lenSealed, ptSealed));
          off += piece.byteLength;
        }
      } finally {
        w.releaseLock();
      }
    },
    async close() { try { await socket.close(); } catch { /* socket already closed */ } },
    async abort() { try { await socket.close(); } catch { /* socket already closed */ } },
  });

  return { readable: ssReadable, writable: ssWritable };
};

/**
 * Build the SS2022 variable header for a target. Exported for tests.
 *
 * Layout:
 *
 *   ATYP=0x01 | v4[4]    | port[BE] | padlen[BE u16] | pad | initial_payload
 *   ATYP=0x03 | dom_len  | dom      | port[BE] | padlen[BE u16] | pad | initial_payload
 *   ATYP=0x04 | v6[16]   | port[BE] | padlen[BE u16] | pad | initial_payload
 *
 * SIP022 requires either non-zero padding OR a non-empty initial_payload in
 * the very first request frame. The dialer has no application data to send
 * yet (the inner TLS handshake hasn't started), so we always emit 16 random
 * padding bytes and an empty initial_payload.
 */
export const buildSs2022RequestHeader = (host: string, port: number): Uint8Array<ArrayBuffer> => {
  assertValidTargetPort(port, 'SS2022');
  const addrSection = encodeAtypAddress(host, { v4: 0x01, domain: 0x03, v6: 0x04 });
  const padLen = 16;
  const pad = randomBytes(padLen);
  const out = new Uint8Array(addrSection.byteLength + 2 + 2 + padLen);
  let off = 0;
  out.set(addrSection, off); off += addrSection.byteLength;
  out[off++] = (port >> 8) & 0xff;
  out[off++] = port & 0xff;
  out[off++] = (padLen >> 8) & 0xff;
  out[off++] = padLen & 0xff;
  out.set(pad, off);
  return out;
};
