// Wire-level vectors covering the response-head parser: status line,
// header name grammar, header value grammar, OWS/whitespace, count caps.
// The vectors are deterministic and each `it(...)` asserts a specific
// HttpProtocolErrorCode (or success body) so a regression points to the
// exact RFC clause.

import { Duplex } from 'node:stream';
import { brotliCompressSync, createBrotliDecompress, gzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { collectBodyBytes, makeFakeDuplex, respondAndEnd } from './test-utils.ts';
import { parseHttpResponse, toWebResponse } from '../src/parser.ts';

describe('parseHttpResponse — status-line grammar', () => {
  it('rejects a status line with two SPs between code and reason (the second SP cannot be absorbed into the reason)', async () => {
    // RFC 9112 §4 grammar puts a single SP between status-code and
    // reason-phrase. A double SP would either silently absorb the extra
    // space into the reason (a lenient-parser foot-gun llhttp's strict
    // mode rejects), or — if accepted — diverge from what a strict
    // intermediary sees. We reject.
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200  OK\r\nContent-Length: 0\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

});

describe('parseHttpResponse — header name grammar (RFC 9110 §5.1 token)', () => {
  // RFC 9110 §5.6.2: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" /
  // "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
  const FORBIDDEN: Record<string, string> = {
    'space inside name': 'X Foo',
    'parenthesis': 'X(Foo',
    'forward slash': 'X/Foo',
  };

  for (const [label, name] of Object.entries(FORBIDDEN)) {
    it(`rejects header name with ${label}`, async () => {
      await expect(parseHttpResponse(respondAndEnd(
        `HTTP/1.1 200 OK\r\n${name}: v\r\nContent-Length: 0\r\n\r\n`,
      ))).rejects.toMatchObject({
        code: 'BAD_HEADERS',
      });
    });
  }

  it.each([
    ['exclamation mark', '!'],
    ['apostrophe', '\''],
    ['backtick', '`'],
    ['tilde', '~'],
  ])('accepts the special tchar %s in header names', async (_label, ch) => {
    const name = `X${ch}Y`;
    const r = await parseHttpResponse(respondAndEnd(
      `HTTP/1.1 200 OK\r\n${name}: v\r\nContent-Length: 0\r\n\r\n`,
    ));
    expect(r.headers.get(name.toLowerCase())).toBe('v');
  });

  it('keeps every field line of a repeated name, in wire order and casing', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Route: one\r\nX-Other: between\r\nx-route: two\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nContent-Length: 0\r\n\r\n',
    ));

    expect(r.headerLines.filter(([name]) => name.toLowerCase() === 'x-route')).toEqual([
      ['X-Route', 'one'],
      ['x-route', 'two'],
    ]);
    expect(r.headerLines.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
    ]);
    // The Headers view merges the repeated name; headerLines is the view that
    // does not.
    expect(r.headers.get('x-route')).toBe('one, two');
  });

  it('drops the decoded Transfer-Encoding from both header views', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nX-Route: one\r\n\r\n0\r\n\r\n',
    ));

    expect(r.headerLines.map(([name]) => name.toLowerCase())).toEqual(['x-route']);
    expect(r.headers.has('transfer-encoding')).toBe(false);
  });
});

describe('parseHttpResponse — header value grammar (RFC 9110 §5.5 field-value)', () => {
  it('rejects every C0 control byte except HTAB (0x09) in the value (RFC 9110 §5.5 field-vchar)', async () => {
    // VCHAR is %x21-7E; the only control byte field-content lets through is
    // HTAB. CR and LF would have already split the line by the time we get
    // here, so the gap this test pins is the rest of the C0 range
    // (0x01-0x08, 0x0B-0x1F).
    for (let b = 0x01; b <= 0x1f; b++) {
      if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
      const fake = makeFakeDuplex();
      fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX: a'));
      fake.respond(new Uint8Array([b]));
      fake.respond('b\r\nContent-Length: 0\r\n\r\n');
      fake.endResponse();
      await expect(parseHttpResponse(fake.readable), `byte 0x${b.toString(16)}`).rejects.toMatchObject({
        code: 'BAD_HEADERS',
      });
    }
  });

  it('rejects bytes ≥ 0x80 in the response header section (RFC 9112 §5: ASCII only)', async () => {
    // RFC 9112 §5 forbids non-ASCII bytes in the header section. A
    // fatal-UTF-8 decoder alone is not enough — valid UTF-8 sequences
    // like 0xc3 0xa9 ("é") decode cleanly but the spec still rejects
    // them. The parser scans for any byte ≥ 0x80 before decoding.
    for (const bytes of [
      [0xff],                       // invalid UTF-8 lead
      [0xc3, 0xa9],                 // valid UTF-8 for "é"
      [0xe4, 0xb8, 0xad],           // valid UTF-8 for "中"
      [0x80],                       // continuation byte in isolation
    ]) {
      const fake = makeFakeDuplex();
      fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX: '));
      fake.respond(new Uint8Array(bytes));
      fake.respond('\r\nContent-Length: 0\r\n\r\n');
      fake.endResponse();
      await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
        code: 'BAD_HEADERS',
      });
    }
  });

  it('rejects obs-fold continuation that starts with SP (RFC 9112 §5.2)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Foo: line1\r\n line2\r\nContent-Length: 0\r\n\r\n',
    ))).rejects.toMatchObject({
      code: 'OBS_FOLD',
    });
  });
});

describe('parseHttpResponse — Content-Length / Transfer-Encoding smuggling matrix', () => {
  // RFC 9112 §6.3: the Content-Length and Transfer-Encoding combinations
  // below are exactly the smuggling-shaped messages a request smuggler
  // exploits to desync front-end and back-end framing.

  it('rejects CL+TE with the CL listed first', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'CL_AND_TE' });
  });

  it('rejects two Content-Length headers carrying the same numeric value', async () => {
    // RFC 9112 §6.3 allows CL repeated with the same value to be folded
    // into one — but this layer rejects all duplicates outright as the
    // safer policy against smuggling proxies that disagree about folding.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello',
    ))).rejects.toMatchObject({ code: 'MULTIPLE_CL' });
  });

  it('rejects a comma-separated dual Content-Length within a single header', async () => {
    // The Headers map will append-fold "5,5" but the parser stores raw
    // values per occurrence; both forms must be rejected.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello',
    ))).rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Transfer-Encoding: chunked, gzip (chunked must be the final coding)', async () => {
    // RFC 9112 §6.1: chunked MUST be the final coding when used.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });
});

describe('parseHttpResponse — DoS caps', () => {
  it('rejects a response with 101 header lines (one past the boundary)', async () => {
    const lines = ['HTTP/1.1 200 OK'];
    for (let i = 0; i < 100; i++) lines.push(`X-${i}: v`);
    lines.push('Content-Length: 0');
    lines.push('');
    lines.push('');
    await expect(parseHttpResponse(respondAndEnd(lines.join('\r\n')))).rejects.toMatchObject({
      code: 'TOO_MANY_HEADERS',
    });
  });

  // The head reader is generic over its cap and error factories; this vector
  // pins the pair `parseHttpResponse` actually wires in — the 64 KiB cap and
  // HEADER_BUFFER_OVERFLOW — so neither an unbounded read nor a different
  // code can pass unnoticed.
  it('rejects a single header that grows past the 64 KiB header buffer', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nX-Big: ');
    fake.respond('a'.repeat(70 * 1024));
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'HEADER_BUFFER_OVERFLOW',
    });
  });
});

describe('parseHttpResponse — body framing', () => {
  it('errors with TRAILING_BODY_BYTES when CL is satisfied and more bytes follow', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloEXTRA');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    await expect(collectBodyBytes(resp)).rejects.toMatchObject({
      code: 'TRAILING_BODY_BYTES',
    });
  });

  it('errors with EOF when CL exceeds the available bytes', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    await expect(collectBodyBytes(resp)).rejects.toMatchObject({
      code: 'EOF',
    });
  });
});

describe('parseHttpResponse — 1xx interim heads', () => {
  it('skips multiple stacked interim heads (100 then 103 then 200)', async () => {
    const r = await parseHttpResponse(respondAndEnd([
      'HTTP/1.1 100 Continue',
      '',
      'HTTP/1.1 103 Early Hints',
      'Link: </a.css>; rel=preload',
      '',
      'HTTP/1.1 200 OK',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n')));
    expect(r.status).toBe(200);
  });
});

describe('toWebResponse', () => {
  it('returns a null-body Response for 204 No Content (Fetch standard refuses a body)', async () => {
    const r = toWebResponse(await parseHttpResponse(respondAndEnd('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')));
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
  });

  it('rejects a content coding the socket transport cannot decode', async () => {
    await expect(async () => {
      toWebResponse(await parseHttpResponse(respondAndEnd(
        'HTTP/1.1 200 OK\r\nContent-Encoding: br\r\nContent-Length: 0\r\n\r\n',
      )));
    }).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'UNSUPPORTED_CONTENT_ENCODING',
      message: expect.stringContaining('br'),
    });
  });

  it('decodes stacked content codings in reverse application order', async () => {
    const text = '{"error":{"type":"rate_limit_error"}}';
    const compressed = brotliCompressSync(gzipSync(text));
    const fake = makeFakeDuplex();
    fake.respond(`HTTP/1.1 429 Too Many Requests\r\nContent-Encoding: gzip, Br\r\nContent-Length: ${compressed.length}\r\n\r\n`);
    fake.respond(compressed);
    fake.endResponse();
    const response = toWebResponse(await parseHttpResponse(fake.readable), new Map([
      ['br', () => Duplex.toWeb(createBrotliDecompress()) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>],
    ]));
    expect(response.status).toBe(429);
    expect(await response.text()).toBe(text);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
  });

  it('preserves a codec initialization failure and cancels its input', async () => {
    const failure = new Error('codec initialization failed');
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    expect(() => toWebResponse({
      status: 429, statusText: 'Too Many Requests', headers: new Headers({ 'content-encoding': 'br' }), headerLines: [], body,
    }, new Map([['br', () => { throw failure; }]]))).toThrow(failure);
    expect(cancel).toHaveBeenCalledWith(failure);
  });
});

describe('parseHttpResponse — reader-lock release on error', () => {
  // A downstream teardown calls `stream.readable.cancel(reason)` on a failed
  // dial. If parseHttpResponse rejects with the reader still locked onto its
  // readable, that cancel hits a locked stream and the cancel cascade
  // silently no-ops. Pin the contract: every throw path releases the reader
  // so the downstream cancel reaches the underlying transport.

  it('releases the reader lock when the head fails to parse (BAD_STATUS_LINE)', async () => {
    const readable = respondAndEnd('not an http response\r\n\r\n');
    await expect(parseHttpResponse(readable)).rejects.toMatchObject({ code: 'BAD_STATUS_LINE' });
    expect(readable.locked).toBe(false);
    await expect(readable.cancel()).resolves.toBeUndefined();
  });
});
