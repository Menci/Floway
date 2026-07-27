// Shadowsocks AEAD-2018 dialer.
//
// Spec: https://shadowsocks.org/doc/aead.html (SIP004 + SIP007).
//
// TCP frame layout:
//   [random salt][len(2B BE) + tag(16B)][payload(<=16K) + tag(16B)]…
//
// Master key:
//   EVP_BytesToKey(password) — MD5-chained: M0 = MD5(password); Mi = MD5(M(i-1) || password); concat to keyLen.
//
// Subkey (per direction):
//   subkey = HKDF-SHA1(masterKey, salt, "ss-subkey", keyLen)
//
// Nonce:
//   12-byte LE counter, starts at 0, +1 per AEAD op.
//
// First plaintext chunk: SOCKS5-style address: [ATYP][addr][port BE]

import { hkdf } from '@noble/hashes/hkdf.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';

import { utf8Bytes, concat, encodeAtypAddress, randomBytes } from '../bytes.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { ProxyDialError } from '../errors.ts';
import { makeExactReader } from '../exact-reader.ts';
import type { ShadowsocksProxyConfig, SsMethod } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { type Aead, leNonce, makeAead } from './shadowsocks-aead.ts';

const METHOD_KEY_LEN: Record<SsMethod, number> = {
  'chacha20-ietf-poly1305': 32,
  'aes-256-gcm': 32,
  'aes-128-gcm': 16,
};

const TAG_LEN = 16;
const MAX_PAYLOAD = 0x3fff;

export const dialShadowsocks = async (
  config: ShadowsocksProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'SS');
  assertValidTargetHost(target.host, 'SS', { maxBytes: 255 });
  const keyLen = METHOD_KEY_LEN[config.method];

  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { signal: options.signal });

  try {
    return await dialShadowsocksInner(socket, config.method, config.password, keyLen, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialShadowsocksInner = async (
  socket: DialedSocket,
  method: SsMethod,
  password: string,
  keyLen: number,
  target: DialTarget,
): Promise<DialResult> => {
  const masterKey = evpBytesToKey(password, keyLen);
  const aeadKind = method === 'chacha20-ietf-poly1305' ? 'chacha' : 'gcm';

  const sendSalt = randomBytes(keyLen);
  const sendSubkey = hkdf(sha1, masterKey, sendSalt, utf8Bytes('ss-subkey'), keyLen);
  const sendCipher = makeAead(aeadKind, sendSubkey);
  let sendNonce = 0n;

  // Receive subkey is derived after we read the server's salt.
  let recvCipher: Aead | null = null;
  let recvNonce = 0n;

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const readExactly = makeExactReader(reader, 'SS');

  const addrBytes = buildSsAddress(target.host, target.port);

  const initialFrame = encryptFrame(sendCipher, addrBytes, sendNonce);
  sendNonce += 2n;
  const initialOut = concat(sendSalt, initialFrame);
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
          const saltBuf = await readExactly(keyLen);
          const recvSubkey = hkdf(sha1, masterKey, saltBuf, utf8Bytes('ss-subkey'), keyLen);
          recvCipher = makeAead(aeadKind, recvSubkey);
        }
        const lenSealed = await readExactly(2 + TAG_LEN);
        const lenPlain = recvCipher.decrypt(leNonce(recvNonce), lenSealed);
        recvNonce++;
        const payloadLen = (lenPlain[0]! << 8) | lenPlain[1]!;
        if (payloadLen === 0 || payloadLen > MAX_PAYLOAD) {
          controller.error(new ProxyDialError(`SS: bad payload length ${payloadLen}`, 'proxy-handshake'));
          return;
        }
        const payloadSealed = await readExactly(payloadLen + TAG_LEN);
        const payloadPlain = recvCipher.decrypt(leNonce(recvNonce), payloadSealed);
        recvNonce++;
        recvBootstrapped = true;
        controller.enqueue(payloadPlain as Uint8Array<ArrayBuffer>);
      } catch (e) {
        if (!recvBootstrapped && !(e instanceof ProxyDialError)) {
          controller.error(new ProxyDialError(`SS handshake decrypt failed: ${e instanceof Error ? e.message : String(e)}`, 'proxy-handshake', { cause: e }));
          return;
        }
        controller.error(e);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  const ssWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      const w = socket.writable.getWriter();
      try {
        let off = 0;
        while (off < chunk.byteLength) {
          const piece = chunk.subarray(off, Math.min(off + MAX_PAYLOAD, chunk.byteLength));
          const frame = encryptFrame(sendCipher, piece, sendNonce);
          sendNonce += 2n;
          await w.write(frame);
          off += piece.byteLength;
        }
      } finally {
        w.releaseLock();
      }
    },
    async close() {
      try { await socket.close(); } catch { /* socket already closed */ }
    },
    async abort() {
      try { await socket.close(); } catch { /* socket already closed */ }
    },
  });

  return { readable: ssReadable, writable: ssWritable };
};

const encryptFrame = (cipher: Aead, payload: Uint8Array, baseNonce: bigint): Uint8Array<ArrayBuffer> => {
  const lenBytes = new Uint8Array(2);
  lenBytes[0] = (payload.byteLength >> 8) & 0xff;
  lenBytes[1] = payload.byteLength & 0xff;
  const lenSealed = cipher.encrypt(leNonce(baseNonce), lenBytes);
  const payloadSealed = cipher.encrypt(leNonce(baseNonce + 1n), payload);
  const out = new Uint8Array(lenSealed.byteLength + payloadSealed.byteLength);
  out.set(lenSealed, 0);
  out.set(payloadSealed, lenSealed.byteLength);
  return out;
};

/** Exported for tests; see header comment for the EVP_BytesToKey derivation. */
export const evpBytesToKey = (password: string, keyLen: number): Uint8Array<ArrayBuffer> => {
  const pw = utf8Bytes(password);
  const out = new Uint8Array(keyLen);
  let prev = new Uint8Array(0);
  let off = 0;
  while (off < keyLen) {
    const buf = concat(prev, pw);
    const m = md5(buf);
    const take = Math.min(m.byteLength, keyLen - off);
    out.set(m.subarray(0, take), off);
    off += take;
    prev = m;
  }
  return out;
};

/** Exported for tests. */
export const buildSsAddress = (host: string, port: number): Uint8Array<ArrayBuffer> => {
  assertValidTargetPort(port, 'SS');
  const addr = encodeAtypAddress(host, { v4: 0x01, domain: 0x03, v6: 0x04 });
  const out = new Uint8Array(addr.byteLength + 2);
  out.set(addr, 0);
  out[addr.byteLength] = (port >> 8) & 0xff;
  out[addr.byteLength + 1] = port & 0xff;
  return out;
};
