import { describe, expect, it } from 'vitest';

import { collectBody, makeFakeDuplex } from './test-utils.ts';
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
        headers: {
          Host: 'api.openai.com',
          Authorization: 'Bearer xxx',
          // These three are stripped by fetchOnStream — the buffered body
          // length is the source of truth.
          'Content-Length': '999',
          'Transfer-Encoding': 'chunked',
          Connection: 'keep-alive',
        },
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
    expect(head).not.toMatch(/Accept-Encoding:/i);
    expect(head).toMatch(/\r\n\r\npayload$/);
  });

  it('does not set Content-Length when there is no body', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).not.toMatch(/Content-Length:/i);
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
      { method: 'GET', path: '/', headers: { Host: 'h' } },
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

describe('fetchOnStream — body-bearing responses', () => {
  it('returns a chunked body whose chunks decode losslessly', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond([
      'HTTP/1.1 200 OK',
      'Content-Type: text/plain',
      'Transfer-Encoding: chunked',
      '',
      // Three chunks: "Wiki", "pedia", " in chunks."
      '4\r\nWiki\r\n5\r\npedia\r\nB\r\n in chunks.\r\n0\r\n\r\n',
    ].join('\r\n'));
    fake.endResponse();
    const resp = await promise;
    expect(await collectBody(resp)).toBe('Wikipedia in chunks.');
  });

  it('returns a Content-Length body whose bytes match exactly', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello world');
    fake.endResponse();
    const resp = await promise;
    expect(await collectBody(resp)).toBe('hello world');
  });

  it('reads to EOF when the response carries neither CL nor TE', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.0 200 OK\r\n\r\nhello there');
    fake.endResponse();
    const resp = await promise;
    expect(await collectBody(resp)).toBe('hello there');
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
      { method: 'GET', path: '/', headers: { Host: 'h', [name]: 'v' } },
    ).catch((e: unknown) => e);
  };

  const FORBIDDEN_NAMES: Record<string, string> = {
    'space inside name': 'X Foo',
    'TAB inside name': 'X\tFoo',
    'CR': 'X\rFoo',
    'LF': 'X\nFoo',
    'NUL': 'X\0Foo',
    'DEL (0x7f)': 'X\x7fFoo',
    'parenthesis (open)': 'X(Foo',
    'parenthesis (close)': 'X)Foo',
    'angle bracket <': 'X<Foo',
    'angle bracket >': 'X>Foo',
    'at sign': 'X@Foo',
    'comma': 'X,Foo',
    'semicolon': 'X;Foo',
    'colon': 'X:Foo',
    'backslash': 'X\\Foo',
    'double quote': 'X"Foo',
    'forward slash': 'X/Foo',
    'square bracket [': 'X[Foo',
    'square bracket ]': 'X]Foo',
    'question mark': 'X?Foo',
    'equals': 'X=Foo',
    'curly brace {': 'X{Foo',
    'curly brace }': 'X}Foo',
  };

  for (const [label, name] of Object.entries(FORBIDDEN_NAMES)) {
    it(`rejects a request header name with ${label}`, async () => {
      const err = await reqHeaderName(name);
      expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
    });
  }

  it('rejects an empty request header name', async () => {
    const err = await reqHeaderName('');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  // RFC 9110 §5.5: field-value control bytes (NUL, CR, LF, DEL) injected
  // by a caller would smuggle a fresh header onto the wire after our
  // `${k}: ${v}\r\n` serialization.
  const reqHeaderValue = async (value: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h', 'X-Test': value } },
    ).catch((e: unknown) => e);
  };

  it('rejects a request header value containing CR (CRLF injection prevention)', async () => {
    const err = await reqHeaderValue('foo\rEvil: bar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a request header value containing LF (LF injection prevention)', async () => {
    const err = await reqHeaderValue('foo\nEvil: bar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a request header value containing NUL', async () => {
    const err = await reqHeaderValue('foo\0bar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a request header value containing DEL (0x7f)', async () => {
    const err = await reqHeaderValue('foo\x7fbar');
    expect(err).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('accepts a request header value containing the typical printable special characters', async () => {
    // ; , = ( ) " < > [ ] { } @ / ? — all allowed in field-value.
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'GET',
        path: '/',
        headers: { Host: 'h', 'X-Test': 'a;b,c=d (e) [f] {g} <h>/?@' },
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).toContain('X-Test: a;b,c=d (e) [f] {g} <h>/?@\r\n');
  });

  it('accepts a request header value containing the legitimate token specials', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'GET',
        path: '/',
        headers: { Host: 'h', 'X-Test': '!#$%&\'*+-.^_`|~' },
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).toContain('X-Test: !#$%&\'*+-.^_`|~\r\n');
  });

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

  it('accepts HTAB (0x09) inside a request header value (RFC 9110 §5.5 field-content)', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'GET',
        path: '/',
        headers: { Host: 'h', 'X-Test': 'a\tb' },
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).toContain('X-Test: a\tb\r\n');
  });
});

describe('fetchOnStream — request-method handling', () => {
  it('rejects a HEAD request at this layer (RFC 9110 §6.4.1; framing would hang)', async () => {
    const fake = makeFakeDuplex();
    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'HEAD', path: '/', headers: { Host: 'h' } },
    )).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'HEAD_REQUEST_REJECTED',
    });
  });

  it('rejects a HEAD request regardless of letter case (head)', async () => {
    const fake = makeFakeDuplex();
    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'head', path: '/', headers: { Host: 'h' } },
    )).rejects.toMatchObject({ code: 'HEAD_REQUEST_REJECTED' });
  });

  it('rejects a HEAD request regardless of letter case (Head)', async () => {
    const fake = makeFakeDuplex();
    await expect(fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'Head', path: '/', headers: { Host: 'h' } },
    )).rejects.toMatchObject({ code: 'HEAD_REQUEST_REJECTED' });
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
      { method, path: '/', headers: { Host: 'h' } },
    ).catch((e: unknown) => e);
  };
  const dialPath = async (path: string): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path, headers: { Host: 'h' } },
    ).catch((e: unknown) => e);
  };

  it('rejects an empty method', async () => {
    expect(await dialMethod('')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a method containing SP (smuggling shape)', async () => {
    expect(await dialMethod('GET POST')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a method containing CR (CRLF injection prevention)', async () => {
    expect(await dialMethod('GET\rEvil: 1')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a method containing LF (LF injection prevention)', async () => {
    expect(await dialMethod('GET\nEvil: 1')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a method containing NUL', async () => {
    expect(await dialMethod('GET\0X')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a method using a non-tchar punctuation byte (colon)', async () => {
    expect(await dialMethod('GE:T')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects an empty path', async () => {
    expect(await dialPath('')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a path containing SP (smuggling shape)', async () => {
    expect(await dialPath('/hi there')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a path containing CR', async () => {
    expect(await dialPath('/foo\rEvil: 1')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a path containing LF', async () => {
    expect(await dialPath('/foo\nEvil: 1')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a path containing NUL', async () => {
    expect(await dialPath('/foo\0bar')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('rejects a path containing DEL (0x7f)', async () => {
    expect(await dialPath('/foo\x7fbar')).toMatchObject({ name: 'HttpProtocolError', code: 'BAD_HEADERS' });
  });

  it('accepts a path containing percent-encoded bytes and query separators', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/v1/messages?stream=true&q=hi%20there', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).toMatch(/^GET \/v1\/messages\?stream=true&q=hi%20there HTTP\/1\.1\r\n/);
  });
});

describe('fetchOnStream — request body serialization', () => {
  it('serializes a Uint8Array body in a single write when it fits in the default chunk size', async () => {
    const body = new TextEncoder().encode('payload');
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'POST', path: '/', headers: { Host: 'h' }, body },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    const text = decodeAscii(fake.written());
    expect(text).toContain('Content-Length: 7\r\n');
    expect(text.endsWith('\r\n\r\npayload')).toBe(true);
  });

  it('splits a body that exceeds the chunk size across multiple writes', async () => {
    // 128 KiB body chunked at 16 KiB → 8 body writes.
    const body = new Uint8Array(128 * 1024).fill(0x41);
    const writeSizes: number[] = [];
    const fake = makeFakeDuplex();
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        writeSizes.push(chunk.byteLength);
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'POST', path: '/', headers: { Host: 'h' }, body },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    // First write is the head; the next eight are 16 KiB each.
    expect(writeSizes.length).toBe(9);
    expect(writeSizes.slice(1)).toEqual([16384, 16384, 16384, 16384, 16384, 16384, 16384, 16384]);
  });

  it('does not write any body bytes when body is undefined', async () => {
    const fake = makeFakeDuplex();
    const writeCount = { n: 0 };
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        writeCount.n++;
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'GET', path: '/', headers: { Host: 'h' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(writeCount.n).toBe(1);
  });

  it('writes only the head when body is an empty Uint8Array', async () => {
    const fake = makeFakeDuplex();
    const writeCount = { n: 0 };
    const writableTap = new WritableStream<Uint8Array>({
      write(chunk) {
        writeCount.n++;
        const w = fake.writable.getWriter();
        return w.write(chunk).finally(() => w.releaseLock());
      },
    });
    const promise = fetchOnStream(
      { readable: fake.readable, writable: writableTap },
      { method: 'POST', path: '/', headers: { Host: 'h' }, body: new Uint8Array(0) },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(writeCount.n).toBe(1);
    // No Content-Length is added for a zero-byte body — matches the
    // current policy (only set CL when bodyLen > 0).
    expect(decodeAscii(fake.written())).not.toMatch(/Content-Length:/i);
  });

  it('preserves a caller-supplied Accept-Encoding header', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h', 'Accept-Encoding': 'gzip' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    const text = decodeAscii(fake.written());
    expect(text).toContain('Accept-Encoding: gzip\r\n');
  });

  it('drops the caller Connection header regardless of case', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h', 'CONNECTION': 'keep-alive' } },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    const text = decodeAscii(fake.written());
    expect(text).toContain('Connection: close\r\n');
    expect(text).not.toContain('keep-alive');
  });

  it('drops a caller transfer-encoding header regardless of case', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      {
        method: 'POST',
        path: '/',
        headers: { Host: 'h', 'transfer-encoding': 'chunked' },
        body: new TextEncoder().encode('x'),
      },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(decodeAscii(fake.written())).not.toMatch(/transfer-encoding/i);
  });
});

describe('fetchOnStream — writer-lock release on rejected calls', () => {
  // The header/method/path validators throw before any I/O; the writer
  // lock must not be held when they do, otherwise the caller's
  // `writable.abort(...)` to tear the transport down would fail with
  // "Cannot abort a stream that already has a writer". A successful
  // round-trip must also release the lock — that one is exercised by
  // every other test indirectly, but pinning it here keeps the contract
  // visible.
  it('does not take the writer lock when validation rejects', async () => {
    const fake = makeFakeDuplex();
    await expect(
      fetchOnStream(
        { readable: fake.readable, writable: fake.writable },
        { method: 'POST', path: '/', headers: { 'X\rEvil': 'v' }, body: undefined },
      ),
    ).rejects.toMatchObject({ code: 'BAD_HEADERS' });
    // After rejection, the writable must be unlocked so the caller can
    // close or abort the transport without a TypeError.
    expect(() => {
      const w = fake.writable.getWriter();
      w.releaseLock();
    }).not.toThrow();
  });

  it('releases the writer lock after a successful response', async () => {
    const fake = makeFakeDuplex();
    const promise = fetchOnStream(
      { readable: fake.readable, writable: fake.writable },
      { method: 'GET', path: '/', headers: { Host: 'h' }, body: undefined },
    );
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await promise;
    expect(() => {
      const w = fake.writable.getWriter();
      w.releaseLock();
    }).not.toThrow();
  });
});
