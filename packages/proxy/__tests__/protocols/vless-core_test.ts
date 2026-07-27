import { describe, expect, it } from 'vitest';

import { vlessFrameOverStream } from '../../src/protocols/vless-core.ts';
import type { DialTarget } from '../../src/types.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
// Spec example UUID, parsed in big-endian byte order:
const UUID_BYTES = [
  0xb8, 0x31, 0x38, 0x1d,
  0x63, 0x24,
  0x4d, 0x53,
  0xad, 0x4f,
  0x8c, 0xda, 0x48, 0xb3, 0x08, 0x11,
];

interface Pair {
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  written: Promise<Uint8Array>;
  pushFromServer: (bytes: Uint8Array) => void;
  endServer: () => void;
}

const makePair = (): Pair => {
  // Dialer-side writes are accumulated until we collect a `length`-bound
  // snapshot.
  let buf = new Uint8Array(0);
  let resolveWritten!: (v: Uint8Array) => void;
  const written = new Promise<Uint8Array>(r => { resolveWritten = r; });
  let writeCount = 0;

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      const next = new Uint8Array(buf.byteLength + chunk.byteLength);
      next.set(buf, 0);
      next.set(chunk, buf.byteLength);
      buf = next;
      writeCount++;
      // The dialer writes the whole VLESS header in one go.
      if (writeCount === 1) resolveWritten(new Uint8Array(buf));
    },
  });

  let serverController!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) { serverController = c; },
  });

  return {
    transport: { readable, writable },
    written,
    pushFromServer(bytes) { serverController.enqueue(bytes); },
    endServer() { serverController.close(); },
  };
};

describe('vlessFrameOverStream — request header', () => {
  it('writes 0x00 | UUID(16) | addonsLen=0 | cmd=0x01 | port(BE) | atyp=0x02 | dom_len | dom', async () => {
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, target);
    const written = await p.written;

    let off = 0;
    expect(written[off++]).toBe(0x00); // version
    expect(Array.from(written.subarray(off, off + 16))).toEqual(UUID_BYTES);
    off += 16;
    expect(written[off++]).toBe(0x00); // addons len
    expect(written[off++]).toBe(0x01); // cmd: TCP
    expect(written[off++]).toBe(0x01); // port hi (443 = 0x01bb)
    expect(written[off++]).toBe(0xbb); // port lo
    expect(written[off++]).toBe(0x02); // atyp: domain
    expect(written[off++]).toBe('api.openai.com'.length);
    expect(new TextDecoder().decode(written.subarray(off, off + 14))).toBe('api.openai.com');
    expect(written.byteLength).toBe(off + 14);
  });

  it('parses dashed and dashless UUIDs identically', async () => {
    const p1 = makePair();
    void vlessFrameOverStream(p1.transport, UUID, target);
    const w1 = await p1.written;

    const p2 = makePair();
    void vlessFrameOverStream(p2.transport, UUID.replace(/-/g, ''), target);
    const w2 = await p2.written;

    expect(Array.from(w1)).toEqual(Array.from(w2));
  });

  it('rejects malformed UUIDs as proxy-handshake before any I/O', async () => {
    const p = makePair();
    await expect(vlessFrameOverStream(p.transport, 'not-a-uuid', target)).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('UUID'),
    });
  });

  it('redacts the malformed UUID value from the dial error message (credential hygiene)', async () => {
    const p = makePair();
    const secret = 'super-secret-credential-leak-vector';
    const err = await vlessFrameOverStream(p.transport, secret, target).then(
      () => { throw new Error('expected the dial to reject'); },
      e => e as Error,
    );
    expect(err.message).not.toContain(secret);
    // The raw value still rides on `cause` so a deliberate debug log can
    // recover it without forcing every log line that prints `.message` to
    // smear the credential.
    expect((err as Error & { cause?: unknown }).cause).toMatchObject({ uuid: secret });
  });
});

describe('vlessFrameOverStream — reply prefix strip', () => {
  it('strips ver=0x00, addons-len=0, and exposes only the post-prefix payload', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;

    // Server reply prefix: ver=0x00 | addonsLen=0x00, then 4 payload bytes.
    p.pushFromServer(new Uint8Array([0x00, 0x00, 0xde, 0xad, 0xbe, 0xef]));

    const result = await dialPromise;
    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expect(Array.from(value!)).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('passes addons bytes through transparently when addonsLen > 0', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;

    // ver=0x00 | addonsLen=3 | addons[3] | payload
    p.pushFromServer(new Uint8Array([0x00, 0x03, 0xaa, 0xbb, 0xcc, 0x11, 0x22]));
    const result = await dialPromise;
    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expect(Array.from(value!)).toEqual([0x11, 0x22]);
  });

  it('errors the readable when the server replies with a non-zero version byte', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;
    p.pushFromServer(new Uint8Array([0x01, 0x00, 0xff]));

    const result = await dialPromise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('bad version'),
    });
  });

  it('errors the readable when the server hangs up before the prefix arrives', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;
    p.endServer();

    const result = await dialPromise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('EOF before prefix'),
    });
  });
});

describe('vlessFrameOverStream — UUID parsing', () => {
  it('accepts mixed-case hex characters', async () => {
    const p = makePair();
    void vlessFrameOverStream(p.transport, 'B831381D-6324-4D53-AD4F-8CDA48B30811', target);
    const written = await p.written;
    expect(Array.from(written.subarray(1, 17))).toEqual(UUID_BYTES);
  });

  it('rejects a UUID of wrong length (31 hex chars)', async () => {
    const p = makePair();
    await expect(vlessFrameOverStream(p.transport, 'b831381d-6324-4d53-ad4f-8cda48b3081', target)).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('UUID'),
    });
  });

  it('rejects a UUID with a non-hex character', async () => {
    const p = makePair();
    await expect(vlessFrameOverStream(p.transport, 'b831381d-6324-4d53-ad4f-8cda48b3081Z', target)).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('UUID'),
    });
  });

  it('rejects an empty UUID string', async () => {
    const p = makePair();
    await expect(vlessFrameOverStream(p.transport, '', target)).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('UUID'),
    });
  });
});

describe('vlessFrameOverStream — port and hostname encoding', () => {
  it('encodes port 80 (BE) as 0x00 0x50', async () => {
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, { host: 'h', port: 80 });
    const written = await p.written;
    // After version + UUID + addonsLen + cmd: bytes 19..20 = port BE.
    expect(written[19]).toBe(0x00);
    expect(written[20]).toBe(0x50);
  });

  it('encodes port 65535 as 0xff 0xff', async () => {
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, { host: 'h', port: 65535 });
    const written = await p.written;
    expect(written[19]).toBe(0xff);
    expect(written[20]).toBe(0xff);
  });

  it('serializes a 1-byte hostname', async () => {
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, { host: 'h', port: 1 });
    const written = await p.written;
    // bytes 21=atyp, 22=dom_len, 23=dom char.
    expect(written[21]).toBe(0x02);
    expect(written[22]).toBe(0x01);
    expect(written[23]).toBe('h'.charCodeAt(0));
  });

  it('serializes a 255-byte hostname (max atyp=0x02 dom_len)', async () => {
    const p = makePair();
    const host = 'a'.repeat(255);
    void vlessFrameOverStream(p.transport, UUID, { host, port: 443 });
    const written = await p.written;
    expect(written[22]).toBe(0xff);
    expect(new TextDecoder().decode(written.subarray(23, 23 + 255))).toBe(host);
  });

  it('emits ATYP=0x02 (domain, length-prefixed) for a true hostname', async () => {
    // VLESS numbering: 0x01 v4, 0x02 domain, 0x03 v6.
    // SOCKS5/SS numbering: 0x01 v4, 0x03 domain, 0x04 v6. Easy to confuse.
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, target);
    const written = await p.written;
    expect(written[21]).toBe(0x02);
  });

  it('emits ATYP=0x01 + 4 raw octets for an IPv4 literal target', async () => {
    // Reference VLESS clients (Xray-core, sing-box) detect literal IPs and
    // emit them as raw octets; sending a literal as a domain string forces
    // a string→bytes conversion on the server side.
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, { host: '1.2.3.4', port: 80 });
    const written = await p.written;
    expect(written[21]).toBe(0x01);
    expect(Array.from(written.subarray(22, 26))).toEqual([1, 2, 3, 4]);
    // No dom_len byte for literal ATYPs; total header = 22 + 4.
    expect(written.byteLength).toBe(22 + 4);
  });

  it('emits ATYP=0x03 + 16 raw octets for an unbracketed IPv6 literal target', async () => {
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, { host: '::1', port: 80 });
    const written = await p.written;
    expect(written[21]).toBe(0x03);
    expect(written[22 + 15]).toBe(0x01);
    expect(written.byteLength).toBe(22 + 16);
  });
});

describe('vlessFrameOverStream — reply prefix edge cases', () => {
  it('handles addonsLen=255 (max u8) by reading the full prefix before exposing payload', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;

    const addons = new Uint8Array(255);
    for (let i = 0; i < addons.byteLength; i++) addons[i] = i & 0xff;
    const payload = new Uint8Array([0xab, 0xcd]);
    p.pushFromServer(new Uint8Array([0x00, 0xff, ...addons, ...payload]));

    const result = await dialPromise;
    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expect(Array.from(value!)).toEqual([0xab, 0xcd]);
  });

  it('buffers across multiple TCP segments — version arrives separately from addons', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;

    p.pushFromServer(new Uint8Array([0x00]));
    p.pushFromServer(new Uint8Array([0x02, 0x11, 0x22]));
    p.pushFromServer(new Uint8Array([0xaa, 0xbb]));

    const result = await dialPromise;
    const reader = result.readable.getReader();
    const first = await reader.read();
    expect(Array.from(first.value!)).toEqual([0xaa, 0xbb]);
  });

  it('errors the readable when EOF arrives mid-addons', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;

    // addonsLen=5 but only 3 bytes follow, then EOF.
    p.pushFromServer(new Uint8Array([0x00, 0x05, 0x11, 0x22, 0x33]));
    p.endServer();

    const result = await dialPromise;
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('EOF in addons'),
    });
  });

  it('forwards a long post-prefix payload chunk-by-chunk', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;

    p.pushFromServer(new Uint8Array([0x00, 0x00]));
    const big = new Uint8Array(8 * 1024);
    for (let i = 0; i < big.byteLength; i++) big[i] = i & 0xff;
    p.pushFromServer(big);

    const result = await dialPromise;
    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expect(value!.byteLength).toBeGreaterThan(0);
    expect(Array.from(value!.subarray(0, 4))).toEqual([0, 1, 2, 3]);
  });

  it('completes prefix strip when the payload is empty (closes cleanly after addons)', async () => {
    const p = makePair();
    const dialPromise = vlessFrameOverStream(p.transport, UUID, target);
    await p.written;
    p.pushFromServer(new Uint8Array([0x00, 0x00]));
    p.endServer();

    const result = await dialPromise;
    const reader = result.readable.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});

describe('vlessFrameOverStream — fixed UUID byte order vector', () => {
  // RFC 4122 §4.1.2 big-endian byte layout. xray-core's encoding/encoding_test.go
  // uses this exact UUID to verify request-header byte order.
  it('packs UUID v4 b831381d-6324-4d53-ad4f-8cda48b30811 in network byte order', async () => {
    const p = makePair();
    void vlessFrameOverStream(p.transport, UUID, target);
    const written = await p.written;
    expect(Array.from(written.subarray(1, 17))).toEqual([
      0xb8, 0x31, 0x38, 0x1d,
      0x63, 0x24,
      0x4d, 0x53,
      0xad, 0x4f,
      0x8c, 0xda, 0x48, 0xb3, 0x08, 0x11,
    ]);
  });
});
