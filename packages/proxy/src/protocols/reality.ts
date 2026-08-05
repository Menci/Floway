// REALITY dialer.
//
// Spec/reference: github.com/XTLS/REALITY  +  XTLS/Xray-core/transport/internet/reality/reality.go
//
// REALITY is a TLS 1.3 client that:
//   1. Spoofs SNI as a real domain (e.g. www.cloudflare.com).
//   2. Overwrites the 32-byte ClientHello.session_id with a client-to-server
//      authentication payload sealed in-place with AES-256-GCM:
//        plaintext = [version_x, version_y, version_z, 0x00, ts(4 BE), shortId(8)]
//        key       = HKDF-SHA256(ECDHE(ephPriv, serverPub), salt=random[0:20], info="REALITY", L=32)
//        nonce     = random[20:32]
//        AAD       = ClientHello bytes (with session_id slot zeroed before the seal)
//        output    = 16-byte ciphertext + 16-byte tag, written back into session_id slot.
//   3. Validates the server's identity by checking the HMAC tag the server
//      stamps into the leaf cert's X.509 signatureValue field:
//        HMAC-SHA512(authKey, leafEd25519Pub) == lastBytes(leafCert.DER, 64)
//      Same 32-byte authKey from step 2. Xray's server overwrites the last 64
//      bytes of the leaf's DER (the BIT STRING content of signatureValue) with
//      the HMAC tag (XTLS/REALITY handshake_server_tls13.go:149-151). The
//      client-side check matches Xray-core's certs[0].Signature ==
//      hmac.Sum(nil) (Xray-core reality.go:84-87). Returning false from
//      onRecvCertificateVerify skips reclaim-tls's standard transcript-
//      signature check; verifyServerCertificate:false additionally suppresses
//      chain validation. Both layers of the default cert-trust pipeline are
//      replaced because REALITY's leaf cert is forged and its signatureValue
//      slot holds an HMAC tag rather than a real signature.
//
// We layer this on top of @reclaimprotocol/tls via three patched hooks:
//   - onKeyPairGenerated: capture the TLS keyshare X25519 private key so
//     onClientHelloPack can derive authKey via the same ECDH the server runs.
//   - onClientHelloPack: seal the session_id in-place after the ClientHello
//     bytes are built; latch authKey for the cert-verify hook below.
//   - onRecvCertificateVerify: replace the standard chain validation with
//     the REALITY HMAC check over the leaf's DER tail, returning false to
//     skip the default signature verify (the cert is forged so a public-key
//     based signature check would always fail) and throwing on miss to
//     abort the handshake.
//
// After REALITY auth completes, the inner protocol is VLESS by convention.

import { gcm } from '@noble/ciphers/aes.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { setCryptoImplementation, makeTLSClient } from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';

import { base64DecodeBytes, copy, utf8Bytes, randomBytes, hexDecode } from '../bytes.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { ProxyDialError } from '../errors.ts';
import type { RealityProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { vlessFrameOverStream } from './vless-core.ts';
import { signalAbortReason } from '@floway-dev/http';

let cryptoInstalled = false;
const ensureCrypto = (): void => {
  if (cryptoInstalled) return;
  setCryptoImplementation(webcryptoCrypto);
  cryptoInstalled = true;
};

/** Xray version stamp baked into the REALITY session_id payload. */
const XRAY_VERSION: [number, number, number] = [25, 4, 30];

// Reality shortIds: per Xray-core's `copy(hello.SessionId[8:], config.ShortId)`,
// any byte slice up to 8 bytes is accepted and the remainder of the 8-byte
// slot stays zero. The URI form encodes the slice as hex (even-length string,
// 0..16 chars → 0..8 bytes). An empty `sid` is valid and packs as all-zeros.
const MAX_SHORT_ID_BYTES = 8;

export const dialReality = async (
  config: RealityProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'REALITY');
  assertValidTargetHost(target.host, 'REALITY', { maxBytes: 255 });
  ensureCrypto();
  let serverPub: Uint8Array<ArrayBuffer>;
  try {
    serverPub = base64UrlDecode(config.publicKey);
  } catch (cause) {
    throw new ProxyDialError('REALITY: invalid base64 in pbk', 'config', { cause });
  }
  if (serverPub.byteLength !== 32) {
    throw new ProxyDialError(
      `REALITY: server pubkey must be 32 bytes, got ${serverPub.byteLength}`,
      'config',
    );
  }
  const shortId = parseShortId(config.shortId);

  // Plain TCP — userspace TLS will do the entire handshake.
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { signal: options.signal });

  try {
    const post = await runRealityHandshake(socket, config, serverPub, shortId, options.signal);
    return await vlessFrameOverStream(post, config.uuid, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const runRealityHandshake = async (
  socket: DialedSocket,
  config: RealityProxyConfig,
  serverPub: Uint8Array<ArrayBuffer>,
  shortId: Uint8Array<ArrayBuffer>,
  signal: AbortSignal | undefined,
): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> => {
  const sessionIdPlain = buildRealitySessionId(XRAY_VERSION, Math.floor(Date.now() / 1000), shortId);

  // Pre-generate the client random so we know it before packClientHello uses it
  const clientRandom = randomBytes(32);
  const sealNonce = clientRandom.subarray(20, 32);

  // The X25519 private key reclaim will use for the keyshare extension.
  // REALITY requires the same keypair be used for both TLS keyshare AND the
  // session_id seal (the server computes X25519(serverPriv, clientKeysharePub)
  // and that's the basis of authKey). We capture it via onKeyPairGenerated and
  // reuse it via Web Crypto deriveBits inside onClientHelloPack.
  let tlsX25519Priv: CryptoKey | null = null;
  // The 32-byte symmetric authKey shared by the session_id seal AND the
  // HMAC the server stamps into the leaf cert's signatureValue. Built inside
  // onClientHelloPack because that's where we have access to the ECDHE
  // output; latched out so onRecvCertificateVerify can read it without
  // re-running HKDF.
  let authKey: Uint8Array | null = null;

  // plainController is wired by the ReadableStream's start() hook below,
  // which fires synchronously the moment the constructor runs.
  let plainController!: ReadableStreamDefaultController<Uint8Array>;
  let plainClosed = false;
  let detachAbortListener: (() => void) | null = null;
  let handshakeOk = false;

  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();

  let handshakeResolve!: () => void;
  let handshakeReject!: (e: unknown) => void;
  const handshakeDone = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });
  // Register a passive sink so a pump-driven rejection never lands as
  // unhandled if it fires before the outer `await handshakeDone` attaches
  // its real handler.
  handshakeDone.catch(() => { /* main handler is the await below */ });

  // Latch teardown so a follow-up onTlsEnd / EOF can't double-close the
  // controller (Node throws ERR_INVALID_STATE on a second close/error). An
  // error path RSTs the writer so the transport tears down hard rather
  // than blocking on a graceful FIN to a peer whose readable just errored;
  // a clean teardown emits the polite write-half close.
  const closePlain = (error?: unknown): void => {
    if (plainClosed) return;
    plainClosed = true;
    detachAbortListener?.();
    detachAbortListener = null;
    try {
      if (error) plainController.error(error);
      else plainController.close();
    } catch { /* already closed/errored */ }
    if (error) void writer.abort(error).catch(() => {});
    else void writer.close().catch(() => {});
  };

  const tlsClient = makeTLSClient(({
    host: config.serverName,
    namedCurves: ['X25519'],
    verifyServerCertificate: false, // REALITY auth replaces chain validation
    write({ header, content }) {
      const out = new Uint8Array(header.byteLength + content.byteLength);
      out.set(header, 0);
      out.set(content, header.byteLength);
      writer.write(out).catch(e => {
        if (!handshakeOk) handshakeReject(e);
        else closePlain(e);
      });
    },
    onHandshake() {
      handshakeOk = true;
      handshakeResolve();
    },
    onApplicationData(plaintext) {
      if (plainClosed) return;
      try {
        plainController.enqueue(copy(plaintext));
      } catch (err) {
        // Pre-close enqueue can only fail if the consumer cancelled mid-flight;
        // route through closePlain so the consumer sees the error rather than
        // hanging on a never-closed stream.
        closePlain(err);
      }
    },
    onTlsEnd(error) {
      if (!handshakeOk) {
        handshakeReject(error ?? new Error('TLS ended before handshake'));
        return;
      }
      closePlain(error);
    },
    onKeyPairGenerated(keyType: string, keyPair: { privKey: CryptoKey; pubKey: CryptoKey }) {
      if (keyType === 'X25519') {
        tlsX25519Priv = keyPair.privKey;
      }
    },
    async onClientHelloPack(clientHelloBytes: Uint8Array) {
      // Seal session_id in place. REALITY's X25519 ECDHE uses the SAME
      // keypair as the TLS keyshare extension (the server runs
      // X25519(serverPriv, clientKeysharePub) and never sees a separate
      // ephemeral key — all auth flows from the keyshare's private key).
      if (!tlsX25519Priv) throw new Error('REALITY: X25519 privKey not captured');
      // importKey + deriveBits reject an off-curve / mistyped pbk with
      // OperationError (DOMException). That's operator-supplied bad
      // input, not a programmer bug, so wrap it as a config-stage dial
      // error — callers branch on `stage` to distinguish bad config
      // from a transport failure.
      let sharedSecret: Uint8Array;
      try {
        const serverPubKey = await crypto.subtle.importKey('raw', serverPub, { name: 'X25519' }, false, []);
        sharedSecret = new Uint8Array(
          await crypto.subtle.deriveBits(
            { name: 'X25519', public: serverPubKey } satisfies EcdhKeyDeriveParams,
            tlsX25519Priv,
            256,
          ),
        );
      } catch (cause) {
        throw new ProxyDialError(
          'REALITY: pbk failed X25519 derive — public key is invalid or off-curve',
          'config',
          { cause },
        );
      }
      // Xray runs HKDF-SHA256 over the shared secret in place (writing 32
      // output bytes back into the 32-byte input buffer). We just call hkdf
      // for 32 bytes.
      authKey = hkdf(sha256, sharedSecret, clientRandom.subarray(0, 20), utf8Bytes('REALITY'), 32);

      const sidStart = 39;
      for (let i = 0; i < 32; i++) {
        if (clientHelloBytes[sidStart + i] !== sessionIdPlain[i]) {
          throw new Error(`REALITY: session_id placeholder mismatch at byte ${i}`);
        }
      }
      const aad = buildRealityAad(clientHelloBytes);
      const sealed = gcm(authKey, sealNonce, aad).encrypt(sessionIdPlain.subarray(0, 16));
      if (sealed.byteLength !== 32) throw new Error(`REALITY: sealed length ${sealed.byteLength}`);
      const out = new Uint8Array(clientHelloBytes.byteLength);
      out.set(clientHelloBytes);
      out.set(sealed, sidStart);
      return out;
    },
    onRecvCertificateVerify(args: {
      certificates: Array<{
        getPublicKey(): { buffer: Uint8Array; algorithm: string };
        internal: { rawData: ArrayBuffer };
      }>;
    }) {
      // The reclaim-tls hook also surfaces the TLS CertificateVerify
      // signature over the transcript, but REALITY auth is a separate HMAC
      // tag the server stamps into the leaf cert's signatureValue field
      // — we ignore the transcript signature here and verify the cert tag.
      if (!authKey) throw new ProxyDialError('REALITY: authKey not derived before CertificateVerify', 'proxy-handshake');
      const leaf = args.certificates[0];
      if (!leaf) throw new ProxyDialError('REALITY: no leaf certificate', 'proxy-handshake');
      verifyRealityLeaf(authKey, new Uint8Array(leaf.internal.rawData), leaf.getPublicKey().buffer);
      return false;
    },
  }) as Parameters<typeof makeTLSClient>[0]);

  // tlsClient is initialized synchronously by makeTLSClient above, so by the
  // time the reader pump or startHandshake invokes any hook it is already in
  // scope.
  const plainReadable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c; },
    cancel(reason) {
      plainClosed = true;
      detachAbortListener?.();
      detachAbortListener = null;
      void tlsClient.end().catch(() => {});
      void reader.cancel(reason).catch(() => {});
      // A non-Error reason is a clean consumer cancel — emit a polite
      // FIN; an Error reason means the consumer hit a failure mid-body,
      // so RST the writer rather than graceful-end a half whose readable
      // just errored.
      if (reason instanceof Error) void writer.abort(reason).catch(() => {});
      else void writer.close().catch(() => {});
    },
  });

  const plainWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      await tlsClient.write(chunk);
    },
    async close() {
      // End the TLS layer and close the underlying transport writer here so
      // the socket's write half is shut explicitly rather than waiting on
      // the outer dial catch to close the whole socket on error.
      try { await tlsClient.end(); } catch { /* TLS already ended */ }
      try { await writer.close(); } catch { /* transport already closed */ }
    },
    async abort(reason) {
      try { await tlsClient.end(); } catch { /* TLS already ended */ }
      try { await writer.abort(reason); } catch { /* transport already aborted */ }
    },
  });

  // Pump bytes from transport → tls.handleReceivedBytes. The finally block
  // releases the reader's lock so a handshake-failure path can reach the
  // outer try/catch and close the socket cleanly without an orphaned lock.
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          await tlsClient.end().catch(() => {});
          // Reclaim's onTlsEnd usually fires for a clean close-notify, but a
          // raw transport EOF without an alert wouldn't trigger it. Drive
          // closePlain ourselves so the consumer's reader unsticks when the
          // peer simply hangs up.
          closePlain();
          return;
        }
        await tlsClient.handleReceivedBytes(value);
      }
    } catch (e) {
      if (!handshakeOk) handshakeReject(e);
      else closePlain(e);
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();

  if (signal) {
    const captured = signal;
    const onAbort = (): void => {
      const reason = signalAbortReason(captured);
      if (!handshakeOk) handshakeReject(reason);
      else closePlain(reason);
      void reader.cancel(reason).catch(() => {});
    };
    captured.addEventListener('abort', onAbort, { once: true });
    detachAbortListener = (): void => captured.removeEventListener('abort', onAbort);
    // addEventListener('abort') on an already-aborted signal does not fire;
    // drive onAbort synchronously so an abort that lands between dial()'s
    // upstream pre-check and this listener install isn't lost.
    if (captured.aborted) onAbort();
  }

  // Trigger the handshake with our pre-built sessionId and random.
  // onClientHelloPack runs inside startHandshake and may throw a typed
  // ProxyDialError (config-stage) for an off-curve / mistyped pbk;
  // onRecvCertificateVerify runs during handshakeDone and may throw a typed
  // ProxyDialError (proxy-handshake stage) on HMAC mismatch or wrong leaf
  // cert type. Both must surface with their original stage tag instead of
  // being rewrapped as 'outer-tls', since callers branch on stage to
  // distinguish auth-shaped rejections from transport-shaped ones. For
  // anything else we can't tell whether the server rejected the seal or the
  // TLS handshake itself failed, so we tag the whole leg as outer-tls.
  try {
    await tlsClient.startHandshake(({ sessionId: sessionIdPlain, random: clientRandom }) as Parameters<typeof tlsClient['startHandshake']>[0]);
    await handshakeDone;
  } catch (cause) {
    detachAbortListener?.();
    detachAbortListener = null;
    void reader.cancel(cause).catch(() => {});
    try { writer.releaseLock(); } catch { /* lock already released */ }
    if (cause instanceof ProxyDialError) throw cause;
    throw new ProxyDialError('REALITY outer tls handshake failed', 'outer-tls', { cause });
  }
  // Leave the abort listener live for the streaming session so a caller-
  // driven abort still tears down the established stream; closePlain detaches
  // it on the next teardown event.

  return { readable: plainReadable, writable: plainWritable };
};

/**
 * Validate a REALITY server's leaf cert by recomputing the HMAC-SHA512 tag
 * the server stamps into the cert's X.509 signatureValue.
 *
 * REALITY's server (XTLS/REALITY handshake_server_tls13.go:149-151) writes
 *   HMAC-SHA512(authKey, leafEd25519Pub)
 * into the last 64 bytes of the leaf cert's DER, which for an Ed25519 cert
 * is the BIT STRING content of the signatureValue field. The client side
 * (Xray-core reality.go:84-87) compares certs[0].Signature against the same
 * HMAC. We do the byte-level equivalent: read the last 64 bytes of the
 * leaf's DER and constant-time-compare against the locally recomputed tag.
 *
 * Throws a ProxyDialError on any mismatch — REALITY's leaf is forged, so
 * this HMAC IS the server-auth signal; failing closed is the security
 * boundary. Exported for tests.
 */
export const verifyRealityLeaf = (authKey: Uint8Array, leafDer: Uint8Array, leafSpki: Uint8Array): void => {
  let leafPub: Uint8Array;
  try {
    leafPub = extractEd25519RawPubKey(leafSpki);
  } catch (cause) {
    throw new ProxyDialError('REALITY: leaf cert is not Ed25519 (REALITY servers always present an Ed25519 leaf)', 'proxy-handshake', { cause });
  }
  if (leafDer.byteLength < 64) {
    throw new ProxyDialError(`REALITY: leaf cert DER is ${leafDer.byteLength} bytes, cannot hold a 64-byte HMAC tag`, 'proxy-handshake');
  }
  const certHmacWire = leafDer.subarray(leafDer.byteLength - 64);
  const tag = hmac(sha512, authKey, leafPub);
  if (!equalBytes(tag, certHmacWire)) {
    throw new ProxyDialError('REALITY: server HMAC-SHA512 over leaf pubkey did not match cert signatureValue', 'proxy-handshake');
  }
};

const base64UrlDecode = (s: string): Uint8Array<ArrayBuffer> =>
  base64DecodeBytes(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '='));

/**
 * Parse REALITY's `sid` URI parameter into the 8-byte slice that fills the
 * second half of the 32-byte session_id payload. Spec allows 0..16 hex
 * chars (0..8 bytes); the slice is zero-padded on the right to 8 bytes,
 * matching Xray-core's `copy(hello.SessionId[8:], config.ShortId)`. An
 * empty / undefined sid is valid and packs as all-zeros — the documented
 * default.
 *
 * Exported for tests.
 */
export const parseShortId = (sid: string | undefined): Uint8Array<ArrayBuffer> => {
  const hex = sid ?? '';
  if (hex.length > MAX_SHORT_ID_BYTES * 2) {
    throw new ProxyDialError(
      `REALITY: shortId hex must be 0..${MAX_SHORT_ID_BYTES * 2} chars, got ${hex.length}`,
      'config',
    );
  }
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = hexDecode(hex);
  } catch (cause) {
    throw new ProxyDialError('REALITY: invalid hex in sid', 'config', { cause });
  }
  const padded = new Uint8Array(MAX_SHORT_ID_BYTES);
  padded.set(raw);
  return padded;
};

/**
 * Build the 32-byte unsealed REALITY session_id payload for the ClientHello.
 * Layout:
 *
 *   [0..3]   Xray version triplet + a zero byte
 *   [4..8]   timestamp (u32 BE seconds since epoch)
 *   [8..16]  short id (8 bytes, zero-padded from the URI's `sid` hex)
 *   [16..32] zero — overwritten by the AEAD ciphertext+tag in place
 *
 * Exported for tests.
 */
export const buildRealitySessionId = (
  ver: [number, number, number],
  tsSec: number,
  shortId: Uint8Array,
): Uint8Array => {
  if (shortId.byteLength !== MAX_SHORT_ID_BYTES) {
    throw new Error(`REALITY: shortId must be ${MAX_SHORT_ID_BYTES} bytes, got ${shortId.byteLength}`);
  }
  const out = new Uint8Array(32);
  out[0] = ver[0];
  out[1] = ver[1];
  out[2] = ver[2];
  out[3] = 0x00;
  out[4] = (tsSec >>> 24) & 0xff;
  out[5] = (tsSec >>> 16) & 0xff;
  out[6] = (tsSec >>> 8) & 0xff;
  out[7] = tsSec & 0xff;
  out.set(shortId, 8);
  return out;
};

/**
 * REALITY's AAD is the ClientHello bytes with the 32-byte session_id slot
 * (offset 39..71) zeroed. Xray fills the slot with the unsealed session_id
 * before sealing, then re-zeros for AAD; we keep them separate from the
 * start so the sealing step is a pure mapping over inputs.
 *
 * Exported for tests.
 */
export const buildRealityAad = (clientHello: Uint8Array): Uint8Array => {
  const aad = new Uint8Array(clientHello.byteLength);
  aad.set(clientHello);
  for (let i = 0; i < 32; i++) aad[39 + i] = 0;
  return aad;
};

// Fixed DER prefix for an Ed25519 SubjectPublicKeyInfo: a SEQUENCE wrapping
// an AlgorithmIdentifier whose OID is 1.3.101.112 (id-Ed25519) and a BIT
// STRING that holds the 32-byte raw key with 0 unused bits.
//   30 2a       SEQUENCE (42 bytes)
//   30 05       SEQUENCE (5 bytes)        — AlgorithmIdentifier
//   06 03 2b 65 70   OID id-Ed25519
//   03 21 00    BIT STRING (33 bytes, 0 unused), followed by 32 raw bytes
// RFC 8410 §4 fixes this exact 12-byte prefix shape.
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a,
  0x30, 0x05,
  0x06, 0x03, 0x2b, 0x65, 0x70,
  0x03, 0x21, 0x00,
]);

/**
 * Extract the raw 32-byte Ed25519 public key from a SubjectPublicKeyInfo
 * DER buffer. Strict-validates the fixed 12-byte prefix from RFC 8410 §4 —
 * anything else means the leaf cert is not an Ed25519 cert, which is a
 * REALITY-server misconfiguration (REALITY's auth design assumes an
 * Ed25519 leaf, per Xray-core's `certs[0].PublicKey.(ed25519.PublicKey)`).
 *
 * Exported for tests.
 */
export const extractEd25519RawPubKey = (spki: Uint8Array): Uint8Array => {
  if (spki.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32) {
    throw new Error(`Ed25519 SPKI must be ${ED25519_SPKI_PREFIX.byteLength + 32} bytes, got ${spki.byteLength}`);
  }
  for (let i = 0; i < ED25519_SPKI_PREFIX.byteLength; i++) {
    if (spki[i] !== ED25519_SPKI_PREFIX[i]) {
      throw new Error(`Ed25519 SPKI prefix mismatch at byte ${i}`);
    }
  }
  return spki.slice(ED25519_SPKI_PREFIX.byteLength);
};
