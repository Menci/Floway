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
});

describe('vlessFrameOverStream — reply prefix edge cases', () => {
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
});
