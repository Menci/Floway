import { describe, expect, it, vi } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import { fetchOnStream } from '../src/fetch-on-stream.ts';

const decodeAscii = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('fetchOnStream — request line and headers', () => {
  it('emits a canonical request line, drops caller framing headers, and adds Connection: close', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'POST',
        path: '/v1/messages?stream=true',
        headers: [
          ['Host', 'api.openai.com'],
          ['Authorization', 'Bearer xxx'],
          // These three are stripped by fetchOnStream — the buffered body
          // length is the source of truth.
          ['Content-Length', '999'],
          ['Transfer-Encoding', 'chunked'],
          ['Connection', 'keep-alive'],
        ],
        body: new TextEncoder().encode('payload'),
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;

    const head = decodeAscii(fake.written());
    expect(head).toMatch(/^POST \/v1\/messages\?stream=true HTTP\/1\.1\r\n/);
    expect(head).toContain('Host: api.openai.com\r\n');
    expect(head).toContain('Authorization: Bearer xxx\r\n');
    expect(head).toContain('Content-Length: 7\r\n');
    expect(head).not.toMatch(/Content-Length: 999/);
    expect(head).not.toMatch(/Transfer-Encoding/i);
    // Connection MUST be normalised to 'close'; this layer is one-shot per duplex.
    expect(head).toContain('Connection: close\r\n');
    expect(head).toMatch(/\r\n\r\npayload$/);
  });

  it('writes one field line per entry, so a repeated name stays repeated', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'GET',
        path: '/',
        headers: [['Host', 'h'], ['X-Route', 'one'], ['X-Other', 'between'], ['X-Route', 'two'], ['X-Route', '']],
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;

    const head = decodeAscii(fake.written());
    expect(head.split('\r\n').filter(line => line.startsWith('X-'))).toEqual([
      'X-Route: one',
      'X-Other: between',
      'X-Route: two',
      'X-Route: ',
    ]);
  });

  it('coalesces an opt.prefix into the same write as the request head', async () => {
    const fake = makeFakeDuplex();
    let firstChunk: Uint8Array | null = null;
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        firstChunk ??= new Uint8Array(chunk);
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'GET', path: '/', headers: [['Host', 'h']] },
      new TextEncoder().encode('PREFIX-BYTES'),
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;

    expect(firstChunk).not.toBeNull();
    const text = decodeAscii(firstChunk!);
    expect(text.startsWith('PREFIX-BYTESGET / HTTP/1.1\r\n')).toBe(true);
  });
});

describe('fetchOnStream — request-side header validation (RFC 9110 §5.6.2 / §5.5)', () => {
  // RFC 9110 §5.6.2: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" /
  // "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA. Anything
  // outside that set in a request header NAME is a smuggling vector — the
  // serialized `${k}: ${v}\r\n` line would inject extra header lines.
  const reqHeaderName = async (name: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: [['Host', 'h'], [name, 'v']] },
    ).catch((e: unknown) => e);
  };

  const FORBIDDEN_NAMES: Record<string, string> = {
    'space inside name': 'X Foo',
    'CR': 'X\rFoo',
    'LF': 'X\nFoo',
    'colon': 'X:Foo',
  };

  for (const [label, name] of Object.entries(FORBIDDEN_NAMES)) {
    it(`rejects a request header name with ${label}`, async () => {
      const err = await reqHeaderName(name);
      expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
    });
  }

  // RFC 9110 §5.5: field-value control bytes (NUL, CR, LF, DEL) injected
  // by a caller would smuggle a fresh header onto the wire after our
  // `${k}: ${v}\r\n` serialization.
  const reqHeaderValue = async (value: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: [['Host', 'h'], ['X-Test', value]] },
    ).catch((e: unknown) => e);
  };

  it('rejects every C0 control byte except HTAB (0x09) in a request header value (RFC 9110 §5.5 field-vchar)', async () => {
    // VCHAR is %x21-7E; the only control byte field-content lets through
    // is HTAB. The request validator covers the full C0 range — the
    // response parser already enforces the same shape, so symmetry
    // closes a smuggling-adjacent path on the request side.
    for (let b = 0x01; b <= 0x1f; b++) {
      if (b === 0x09) continue;
      const err = await reqHeaderValue(`a${String.fromCharCode(b)}b`);
      expect(err, `byte 0x${b.toString(16)}`).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
    }
  });
});

describe('fetchOnStream — request-method handling', () => {
  it('rejects a HEAD request at this layer (RFC 9110 §6.4.1; framing would hang)', async () => {
    const fake = makeFakeDuplex();
    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'HEAD', path: '/', headers: [['Host', 'h']] },
    )).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'HEAD_REQUEST_REJECTED',
    });
  });
});

describe('fetchOnStream — request-line smuggling defense (RFC 9110 §9.1 / RFC 9112 §3.2)', () => {
  // A CR/LF/SP/NUL inside the method or path would split the request line
  // and inject a forged head onto the wire — the same anti-smuggling shape
  // the header-name/value validators close.
  const dialMethod = async (method: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method, path: '/', headers: [['Host', 'h']] },
    ).catch((e: unknown) => e);
  };
  const dialPath = async (path: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path, headers: [['Host', 'h']] },
    ).catch((e: unknown) => e);
  };

  it('rejects a method containing SP (smuggling shape)', async () => {
    expect(await dialMethod('GET POST')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a path containing SP (smuggling shape)', async () => {
    expect(await dialPath('/hi there')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });
});

describe('fetchOnStream — request body serialization', () => {
  it('writes a declared-length stream without changing its HTTP framing', async () => {
    const fake = makeFakeDuplex();
    const chunks = ['streamed ', 'body'];
    let pulls = 0;
    const body = {
      contentLength: 13,
      open: () => new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[pulls++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(chunk));
        },
      }),
    };
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'POST', path: '/', headers: [['Host', 'h']], body },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();

    await promise;

    const text = decodeAscii(fake.written());
    expect(text).toContain('Content-Length: 13\r\n');
    expect(text.endsWith('\r\n\r\nstreamed body')).toBe(true);
    expect(pulls).toBe(3);
  });

  it('does not pull the next body chunk while the writer is backpressured', async () => {
    const fake = makeFakeDuplex();
    const blocked = Promise.withResolvers<void>();
    let pulls = 0;
    let writes = 0;
    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        writes += 1;
        if (writes === 2) await blocked.promise;
        const writer = fake.writable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      },
    });
    const body = {
      contentLength: 2,
      open: () => new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls <= 2) controller.enqueue(new Uint8Array([0x60 + pulls]));
          else controller.close();
        },
      }, { highWaterMark: 0 }),
    };
    const promise = fetchOnStream(
      { readable: fake.readable, writable },
      { method: 'POST', path: '/', headers: [['Host', 'h']], body },
    );

    await vi.waitFor(() => expect(writes).toBe(2));
    expect(pulls).toBe(1);
    blocked.resolve();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();

    await promise;
    expect(pulls).toBe(3);
  });

  it.each([
    { contentLength: 2, payload: 'one', title: 'exceeds' },
    { contentLength: 4, payload: 'one', title: 'ends before' },
  ])('rejects a stream that $title its declared length', async ({ contentLength, payload }) => {
    const fake = makeFakeDuplex();
    const body = {
      contentLength,
      open: () => new Blob([payload]).stream(),
    };

    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'POST', path: '/', headers: [['Host', 'h']], body },
    )).rejects.toThrow(RangeError);
  });

  it('cancels the source with the original writer failure', async () => {
    const fake = makeFakeDuplex();
    const failure = new Error('socket write failed');
    const cancel = vi.fn(() => {
      throw new Error('source cancellation failed');
    });
    let writes = 0;
    const writable = new WritableStream<Uint8Array>({
      write() {
        writes += 1;
        if (writes === 2) throw failure;
      },
    });

    const promise = fetchOnStream(
      { readable: fake.readable, writable },
      {
        method: 'POST',
        path: '/',
        headers: [['Host', 'h']],
        body: {
          contentLength: 1,
          open: () => new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel,
          }),
        },
      },
    );

    await expect(promise).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledWith(failure);
  });
});

describe('fetchOnStream — writer-lock release on rejected calls', () => {
  // The header/method/path validators throw before any I/O; the writer
  // lock must not be held when they do, otherwise the caller's
  // `writable.abort(...)` to tear the transport down would fail with
  // "Cannot abort a stream that already has a writer".
  it('does not take the writer lock when validation rejects', async () => {
    const fake = makeFakeDuplex();
    await expect(
      fetchOnStream(
        { readable: fake.readable, writable: fake.writable },
        { method: 'POST', path: '/', headers: [['X\rEvil', 'v']], body: undefined },
      ),
    ).rejects.toMatchObject({ code: 'BAD_HEADERS' });
    // After rejection, the writable must be unlocked so the caller can
    // close or abort the transport without a TypeError.
    expect(() => {
      const w = fake.writable.getWriter();
      w.releaseLock();
    }).not.toThrow();
  });
});
