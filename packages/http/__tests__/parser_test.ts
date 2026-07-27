// Wire-level vectors covering the response-head parser: status line,
// header name grammar, header value grammar, OWS/whitespace, count caps.
// The vectors are deterministic and each `it(...)` asserts a specific
// HttpProtocolErrorCode (or success body) so a regression points to the
// exact RFC clause.

import { describe, expect, it } from 'vitest';

import { collectBody, collectBodyBytes, makeFakeDuplex, respondAndEnd } from './test-utils.ts';
import { parseHttpResponse, toWebResponse } from '../src/parser.ts';

describe('parseHttpResponse — status-line grammar', () => {
  it('accepts HTTP/1.0 200 OK', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(200);
  });

  it('accepts HTTP/1.1 200 OK', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(200);
  });

  it('accepts a long, punctuated reason phrase', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 a really long reason phrase, with spaces & punctuation, OK?\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.status).toBe(200);
  });

  it('accepts the upper end of the Response-constructible range (599)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 599 Strange\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(599);
  });

  it('accepts an unusual 4xx status (e.g. 418 I\'m a teapot)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 418 I\'m a teapot\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(418);
  });

  it('rejects HTTP/2.0 — only HTTP/1.0 and HTTP/1.1 are supported', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/2.0 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects HTTP/0.9', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/0.9 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects HTTP/1.2', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.2 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a 2-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 99 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a 4-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 1000 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a 1-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 2 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a non-digit status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 abc OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a status code with embedded space', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 2 0 0 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a status line missing the SP after status code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

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

  it('rejects a status line with two SPs between version and code', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1  200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a TAB instead of SP after the version', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1\t200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a lowercase scheme (http/1.1)', async () => {
    await expect(parseHttpResponse(respondAndEnd('http/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects a leading CR before the status line (CR-prefixed garbage)', async () => {
    await expect(parseHttpResponse(respondAndEnd('\rHTTP/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects RTSP/1.1 — this layer is HTTP-only', async () => {
    await expect(parseHttpResponse(respondAndEnd('RTSP/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects ICE/1.1 — this layer is HTTP-only', async () => {
    await expect(parseHttpResponse(respondAndEnd('ICE/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects HTTPER/1.1 with a message naming the bad version prefix', async () => {
    // RTSP/ICE branch above rejects via the "does not begin with HTTP/"
    // check. HTTPER starts with HTTP — so this case lands on the
    // version-tuple check, which surfaces the actual seen status line in
    // the error message.
    await expect(parseHttpResponse(respondAndEnd('HTTPER/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
      message: expect.stringContaining('HTTPER/1.1'),
    });
  });

  it('rejects an extra leading zero in the major version (HTTP/01.1)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/01.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });

  it('rejects an LF-only line ending instead of CRLF', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\nContent-Length: 0\n\n'))).rejects.toMatchObject({
      code: 'EOF',
    });
  });

  it('rejects garbage before the status line', async () => {
    await expect(parseHttpResponse(respondAndEnd('garbage HTTP/1.1 200 OK\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_STATUS_LINE',
    });
  });
});

describe('parseHttpResponse — header name grammar (RFC 9110 §5.1 token)', () => {
  // RFC 9110 §5.6.2: tchar = "!" / "#" / "$" / "%" / "&" / "'" / "*" /
  // "+" / "-" / "." / "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
  const FORBIDDEN: Record<string, string> = {
    'space inside name': 'X Foo',
    'tab inside name': 'X\tFoo',
    'parenthesis (open)': 'X(Foo',
    'parenthesis (close)': 'X)Foo',
    'angle bracket <': 'X<Foo',
    'angle bracket >': 'X>Foo',
    'at sign': 'X@Foo',
    'comma': 'X,Foo',
    'semicolon': 'X;Foo',
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

  for (const [label, name] of Object.entries(FORBIDDEN)) {
    it(`rejects header name with ${label}`, async () => {
      await expect(parseHttpResponse(respondAndEnd(
        `HTTP/1.1 200 OK\r\n${name}: v\r\nContent-Length: 0\r\n\r\n`,
      ))).rejects.toMatchObject({
        code: 'BAD_HEADERS',
      });
    });
  }

  it('rejects an empty header name (line starting with colon)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\n: foo\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects whitespace between header name and colon (RFC 9112 §5.1)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nFoo : bar\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects a header line missing the colon', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nFoo bar\r\n\r\n'))).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it.each([
    ['exclamation mark', '!'],
    ['hash', '#'],
    ['dollar', '$'],
    ['percent', '%'],
    ['ampersand', '&'],
    ['apostrophe', '\''],
    ['asterisk', '*'],
    ['plus', '+'],
    ['hyphen', '-'],
    ['period', '.'],
    ['caret', '^'],
    ['underscore', '_'],
    ['backtick', '`'],
    ['pipe', '|'],
    ['tilde', '~'],
  ])('accepts the special tchar %s in header names', async (_label, ch) => {
    const name = `X${ch}Y`;
    const r = await parseHttpResponse(respondAndEnd(
      `HTTP/1.1 200 OK\r\n${name}: v\r\nContent-Length: 0\r\n\r\n`,
    ));
    expect(r.headers.get(name.toLowerCase())).toBe('v');
  });

  it('accepts mixed-case header names and exposes them lowercased via Headers', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-MiXeD-CaSe: v\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('x-mixed-case')).toBe('v');
  });

  it('accepts a header name made of only digits (RFC 9110 §5.6.2)', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\n12345: v\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('12345')).toBe('v');
  });

  it('accepts a single-character header name', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nA: v\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('a')).toBe('v');
  });

  it('rejects a DEL byte in the header name', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX'));
    fake.respond(new Uint8Array([0x7f]));
    fake.respond('Foo: v\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects a NUL byte in the header name', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX'));
    fake.respond(new Uint8Array([0x00]));
    fake.respond('Foo: v\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });
});

describe('parseHttpResponse — header value grammar (RFC 9110 §5.5 field-value)', () => {
  it('accepts an empty value (`X:` with nothing after)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX-Empty:\r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x-empty')).toBe('');
  });

  it('accepts an empty value with a single SP between colon and CRLF', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX-Empty: \r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x-empty')).toBe('');
  });

  it('trims a single leading SP before the value', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX: foo\r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x')).toBe('foo');
  });

  it('trims multiple leading SPs and TABs before the value (OWS = *( SP / HTAB ))', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX:  \t  foo\r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x')).toBe('foo');
  });

  it('trims trailing OWS from the value', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nX: foo \t \r\nContent-Length: 0\r\n\r\n'));
    expect(r.headers.get('x')).toBe('foo');
  });

  it('preserves internal SPs in the value', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX: foo bar baz\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('x')).toBe('foo bar baz');
  });

  it('rejects a NUL (0x00) byte in the value', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX: a'));
    fake.respond(new Uint8Array([0x00]));
    fake.respond('b\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

  it('rejects a DEL (0x7f) byte in the value', async () => {
    const fake = makeFakeDuplex();
    fake.respond(new TextEncoder().encode('HTTP/1.1 200 OK\r\nX: a'));
    fake.respond(new Uint8Array([0x7f]));
    fake.respond('b\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    await expect(parseHttpResponse(fake.readable)).rejects.toMatchObject({
      code: 'BAD_HEADERS',
    });
  });

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

  it('preserves duplicate-named headers as a comma-joined Headers entry', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Dup: a\r\nX-Dup: b\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('x-dup')).toMatch(/^a,\s?b$/);
  });

  it('rejects obs-fold continuation that starts with SP (RFC 9112 §5.2)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Foo: line1\r\n line2\r\nContent-Length: 0\r\n\r\n',
    ))).rejects.toMatchObject({
      code: 'OBS_FOLD',
    });
  });

  it('rejects obs-fold continuation that starts with TAB (RFC 9112 §5.2)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Foo: line1\r\n\tline2\r\nContent-Length: 0\r\n\r\n',
    ))).rejects.toMatchObject({
      code: 'OBS_FOLD',
    });
  });

  it('rejects obs-fold even when the continuation is just SP+CRLF (empty fold)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nX-Foo: line1\r\n \r\nContent-Length: 0\r\n\r\n',
    ))).rejects.toMatchObject({
      code: 'OBS_FOLD',
    });
  });

  it('accepts a value that itself contains a colon (only the first colon is the delimiter)', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nLocation: https://example.com:8443/x\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('location')).toBe('https://example.com:8443/x');
  });

  it('accepts a value with the legitimate special-character set { , ; = ( ) }', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset="utf-8" (preferred)\r\nContent-Length: 0\r\n\r\n',
    ));
    expect(r.headers.get('content-type')).toBe('text/html; charset="utf-8" (preferred)');
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

  it('rejects CL+TE with the TE listed first', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
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

  it('rejects two Content-Length headers carrying different numeric values', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 10\r\n\r\nhellohello',
    ))).rejects.toMatchObject({ code: 'MULTIPLE_CL' });
  });

  it('rejects a comma-separated dual Content-Length within a single header', async () => {
    // The Headers map will append-fold "5,5" but the parser stores raw
    // values per occurrence; both forms must be rejected.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length: 5, 5\r\n\r\nhello',
    ))).rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Transfer-Encoding: gzip alone (we do not honor non-chunked TE)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('rejects Transfer-Encoding: identity', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: identity\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('rejects Transfer-Encoding: chunked, gzip (chunked must be the final coding)', async () => {
    // RFC 9112 §6.1: chunked MUST be the final coding when used.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, gzip\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('accepts Transfer-Encoding: gzip, chunked (chunked is the final coding)', async () => {
    // RFC 9112 §6.1: legal — the parser only consumes chunked framing and
    // exposes the gzip-encoded body bytes verbatim. Decoding gzip is the
    // caller's job.
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ));
    expect(await collectBody(r)).toBe('hello');
  });

  it('rejects Transfer-Encoding: chunked listed twice (across two headers)', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_DOUBLE_CHUNKED' });
  });

  it('rejects Transfer-Encoding: chunked, chunked within one header value', async () => {
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked, chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_DOUBLE_CHUNKED' });
  });

  it('rejects Transfer-Encoding: chunkedchunked (substring match must not enable chunked)', async () => {
    // llhttp test/response/transfer-encoding.md: the literal token must
    // be `chunked`, never a token that contains `chunked` as a substring.
    await expect(parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunkedchunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n',
    ))).rejects.toMatchObject({ code: 'TE_NOT_CHUNKED' });
  });

  it('does not treat Content-Length-X as Content-Length (prefix match must not fire)', async () => {
    // llhttp test/response/content-length.md: a header that merely starts
    // with the literal `Content-Length` is not Content-Length.
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length-X: 0\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nOK\r\n0\r\n\r\n',
    ));
    expect(await collectBody(r)).toBe('OK');
  });

  it('accepts Content-Length with surrounding whitespace (OWS trimmed by header parser)', async () => {
    // The header value parser strips OWS before storing the raw value, so
    // a CL of `   5   ` reaches the framing layer as `5`.
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 200 OK\r\nContent-Length:   5   \r\n\r\nhello',
    ));
    expect(await collectBody(r)).toBe('hello');
  });
});

describe('parseHttpResponse — Content-Length value grammar', () => {
  it('rejects Content-Length: -1 (RFC 9112 §8.6)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 1.5 (must be a non-negative integer)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 1.5\r\n\r\nh')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 0xa (hex prefix is not allowed)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 0xa\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 12abc (trailing non-digit garbage)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 12abc\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length: 1 1 (RFC 9112 §8.6 forbids embedded space)', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 1 1\r\n\r\nhh')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects Content-Length with a leading + sign', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: +5\r\n\r\nhello')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('rejects an empty Content-Length value', async () => {
    await expect(parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length:\r\n\r\n')))
      .rejects.toMatchObject({ code: 'BAD_CL' });
  });

  it('accepts Content-Length: 0 with no body bytes', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'));
    expect(await collectBody(r)).toBe('');
  });

  it('accepts a large Content-Length value (within 32-bit range)', async () => {
    const len = 70_000;
    const fake = makeFakeDuplex();
    fake.respond(`HTTP/1.1 200 OK\r\nContent-Length: ${len}\r\n\r\n`);
    fake.respond(new Uint8Array(len).fill(0x61));
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    const buf = await collectBodyBytes(resp);
    expect(buf.byteLength).toBe(len);
  });
});

describe('parseHttpResponse — DoS caps', () => {
  it('rejects a response with more than 100 header lines as TOO_MANY_HEADERS', async () => {
    const lines = ['HTTP/1.1 200 OK'];
    for (let i = 0; i < 110; i++) lines.push(`X-${i}: v`);
    lines.push('Content-Length: 0');
    lines.push('');
    lines.push('');
    await expect(parseHttpResponse(respondAndEnd(lines.join('\r\n')))).rejects.toMatchObject({
      code: 'TOO_MANY_HEADERS',
    });
  });

  it('accepts a response at exactly the 100-header boundary', async () => {
    const lines = ['HTTP/1.1 200 OK'];
    for (let i = 0; i < 99; i++) lines.push(`X-${i}: v`);
    lines.push('Content-Length: 0');
    lines.push('');
    lines.push('');
    const r = await parseHttpResponse(respondAndEnd(lines.join('\r\n')));
    expect(r.status).toBe(200);
  });

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

  it('accepts a response with zero headers', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK\r\n\r\n'));
    expect(r.status).toBe(200);
  });
});

describe('parseHttpResponse — body framing', () => {
  it('uses chunked framing when Transfer-Encoding ends in chunked', async () => {
    const fake = makeFakeDuplex();
    fake.respond([
      'HTTP/1.1 200 OK',
      'Transfer-Encoding: chunked',
      '',
      '5\r\nhello\r\n0\r\n\r\n',
    ].join('\r\n'));
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello');
    // The internal transfer-encoding header is stripped because it has been
    // decoded — re-exposing it would mislead downstream consumers.
    expect(resp.headers.get('transfer-encoding')).toBeNull();
  });

  it('falls back to read-until-EOF when neither CL nor TE is present (HTTP/1.0 style)', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.0 200 OK\r\n\r\nhello world');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello world');
  });

  it('reads to EOF when no framing headers are present (HTTP/1.1)', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\n\r\nbody bytes');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('body bytes');
  });

  it('errors with TRAILING_BODY_BYTES when CL is satisfied and more bytes follow', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhelloEXTRA');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    await expect(collectBodyBytes(resp)).rejects.toMatchObject({
      code: 'TRAILING_BODY_BYTES',
    });
  });

  it('errors with TRAILING_BODY_BYTES when CL: 0 is followed by any body byte', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\nX');
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

  it('streams CL body across multiple transport reads', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello');
    fake.respond(' world');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(await collectBody(resp)).toBe('hello world');
  });

  it('returns an empty body when CL: 0 with no following bytes', async () => {
    const fake = makeFakeDuplex();
    fake.respond('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    fake.endResponse();
    const resp = await parseHttpResponse(fake.readable);
    expect(resp.status).toBe(200);
    expect(await collectBody(resp)).toBe('');
  });
});

describe('parseHttpResponse — 1xx interim heads', () => {
  // RFC 9112 §6 + RFC 9110 §15.2: a server may emit any number of 1xx
  // interim responses before the final non-1xx. They MUST NOT carry a
  // body. The parser consumes them transparently — the public API only
  // ever surfaces a non-1xx final response.
  it('skips a 100 Continue and returns the following 200', async () => {
    const r = await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello',
    ));
    expect(r.status).toBe(200);
    expect(r.statusText).toBe('OK');
  });

  it('skips a 103 Early Hints carrying preconnect Link headers', async () => {
    // 103 typically carries Link: preconnect headers that an intermediary
    // could legitimately set; we still discard the whole interim head.
    const r = await parseHttpResponse(respondAndEnd([
      'HTTP/1.1 103 Early Hints',
      'Link: </a.css>; rel=preload',
      '',
      'HTTP/1.1 200 OK',
      'Content-Length: 2',
      '',
      'OK',
    ].join('\r\n')));
    expect(r.status).toBe(200);
    expect(r.headers.get('link')).toBeNull();
  });

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

describe('parseHttpResponse — wire-faithful return shape', () => {
  // parseHttpResponse returns a wire-faithful struct rather than a Web
  // Response so 204/304 (which the Response constructor rejects with a
  // non-null body) are representable. Bridging to a Response is
  // toWebResponse's job.
  it('parses a 204 No Content and exposes a (zero-length) body stream', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n'));
    expect(r.status).toBe(204);
    expect(r.body).toBeInstanceOf(ReadableStream);
  });

  it('parses a 304 Not Modified and exposes a (zero-length) body stream', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 304 Not Modified\r\nETag: "abc"\r\n\r\n'));
    expect(r.status).toBe(304);
    expect(r.headers.get('etag')).toBe('"abc"');
  });

  it('exposes the parsed reason-phrase via statusText', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 418 I\'m a teapot\r\nContent-Length: 0\r\n\r\n'));
    expect(r.statusText).toBe('I\'m a teapot');
  });

  it('exposes an empty statusText when the reason-phrase is empty (RFC 7230 erratum 4087)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 \r\nContent-Length: 0\r\n\r\n'));
    expect(r.statusText).toBe('');
  });

  it('trims trailing OWS from the reason-phrase (matches RawHttpResponse.statusText contract)', async () => {
    const r = await parseHttpResponse(respondAndEnd('HTTP/1.1 200 OK   \r\nContent-Length: 0\r\n\r\n'));
    expect(r.statusText).toBe('OK');
  });
});

describe('toWebResponse', () => {
  it('passes 200..599 through with the parsed status and headers', async () => {
    const r = toWebResponse(await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\nContent-Length: 0\r\n\r\n',
    )));
    expect(r.status).toBe(503);
    expect(r.headers.get('retry-after')).toBe('30');
  });

  it('returns a null-body Response for 204 No Content (Fetch standard refuses a body)', async () => {
    const r = toWebResponse(await parseHttpResponse(respondAndEnd('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')));
    expect(r.status).toBe(204);
    expect(r.body).toBeNull();
  });

  it('returns a null-body Response for 304 Not Modified', async () => {
    const r = toWebResponse(await parseHttpResponse(respondAndEnd('HTTP/1.1 304 Not Modified\r\nETag: "abc"\r\n\r\n')));
    expect(r.status).toBe(304);
    expect(r.body).toBeNull();
    expect(r.headers.get('etag')).toBe('"abc"');
  });

  it('forwards the parsed reason-phrase through statusText', async () => {
    const r = toWebResponse(await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 418 I\'m a teapot\r\nContent-Length: 0\r\n\r\n',
    )));
    expect(r.status).toBe(418);
    expect(r.statusText).toBe('I\'m a teapot');
  });

  it('forwards the parsed reason-phrase on a null-body 204 too', async () => {
    const r = toWebResponse(await parseHttpResponse(respondAndEnd(
      'HTTP/1.1 204 No Content Here\r\nContent-Length: 0\r\n\r\n',
    )));
    expect(r.status).toBe(204);
    expect(r.statusText).toBe('No Content Here');
    expect(r.body).toBeNull();
  });

  it('throws BAD_STATUS_LINE when handed a status the Fetch standard refuses to model', () => {
    // parseHttpResponse will never produce a 1xx (it skips them internally),
    // but the bridge function still validates. A handcrafted struct mirrors
    // what an out-of-spec caller could pass.
    const fake = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    expect(() => toWebResponse({ status: 99, statusText: 'X', headers: new Headers(), body: fake })).toThrow(
      expect.objectContaining({ name: 'HttpProtocolError', code: 'BAD_STATUS_LINE' }),
    );
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

  it('releases the reader lock when the head EOFs before terminator', async () => {
    const readable = respondAndEnd('HTTP/1.1 200 OK\r\nContent-Type: text/plain');
    await expect(parseHttpResponse(readable)).rejects.toMatchObject({ code: 'EOF' });
    expect(readable.locked).toBe(false);
  });

  it('releases the reader lock when finalizeResponse rejects CL+TE smuggling', async () => {
    const readable = respondAndEnd('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n');
    await expect(parseHttpResponse(readable)).rejects.toMatchObject({ code: 'CL_AND_TE' });
    expect(readable.locked).toBe(false);
  });
});
