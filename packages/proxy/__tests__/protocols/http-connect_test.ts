import { describe, expect, it } from 'vitest';

import { ProxyDialError } from '../../src/errors.ts';
import { dialHttpConnect } from '../../src/protocols/http-connect.ts';
import type { HttpProxyConfig } from '../../src/proxy-config.ts';
import type { DialOptions, DialTarget } from '../../src/types.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };

const httpConfig = (overrides: Partial<HttpProxyConfig> = {}): HttpProxyConfig => ({
  kind: 'http',
  tls: false,
  host: 'proxy.example',
  port: 3128,
  name: 'p',
  ...overrides,
});

describe('dialHttpConnect — request line', () => {
  it('emits CONNECT host:port HTTP/1.1 with a Host header that matches the authority', async () => {
    const fake = makeFakeSocketDial();
    const opts: DialOptions = { socketDial: fake.socketDial };
    const promise = dialHttpConnect(httpConfig(), target, opts);
    const srv = await fake.awaitConnect();

    // We don't pre-assume how many bytes the dialer batches; pull until the
    // double-CRLF terminator and decode in one shot.
    const decoder = new TextDecoder();
    let head = '';
    while (!head.includes('\r\n\r\n')) {
      const chunk = await srv.read(1);
      head += decoder.decode(chunk, { stream: true });
    }
    expect(head).toContain('CONNECT api.openai.com:443 HTTP/1.1\r\n');
    expect(head).toContain('Host: api.openai.com:443\r\n');
    expect(head).not.toContain('Proxy-Authorization');

    srv.respond('HTTP/1.1 200 Connection Established\r\n\r\n');
    await promise;
  });

  it('embeds Proxy-Authorization: Basic <base64> when credentials are configured', async () => {
    const fake = makeFakeSocketDial();
    const opts: DialOptions = { socketDial: fake.socketDial };
    const promise = dialHttpConnect(
      httpConfig({ username: 'aladdin', password: 'open sesame' }),
      target,
      opts,
    );
    const srv = await fake.awaitConnect();

    const decoder = new TextDecoder();
    let head = '';
    while (!head.includes('\r\n\r\n')) {
      head += decoder.decode(await srv.read(1), { stream: true });
    }
    // RFC 7617 Basic-auth canonical example.
    expect(head).toContain('Proxy-Authorization: Basic YWxhZGRpbjpvcGVuIHNlc2FtZQ==\r\n');

    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });
});

describe('dialHttpConnect — happy path body forwarding', () => {
  it('returns a stream whose readable carries post-handshake bytes', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    // Drain the request head.
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) {
      await srv.read(1);
    }
    while (srv.peekWritten().byteLength) await srv.read(srv.peekWritten().byteLength);

    // Server response includes 4 bytes of post-handshake payload riding in
    // the same TCP segment as the CONNECT 200.
    srv.respond('HTTP/1.1 200 Connection Established\r\n\r\nDATA');
    const result = await promise;

    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value!)).toBe('DATA');

    srv.respond('MORE');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value!)).toBe('MORE');

    srv.endResponse();
    const eof = await reader.read();
    expect(eof.done).toBe(true);
  });
});

describe('dialHttpConnect — failure modes', () => {
  it('classifies tcp-connect failures with the underlying cause', async () => {
    const fake = makeFakeSocketDial();
    fake.failNextConnect(new Error('ECONNREFUSED'));
    await expect(
      dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('tcp connect to proxy.example:3128 failed'),
    });
  });

  it('surfaces 407 Proxy Authentication Required as a typed proxy-handshake error', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    srv.respond('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n');
    const result = await promise;
    // The CONNECT error rides through the post-CONNECT readable as an error
    // — assert on the readable rather than the dial promise (the dial
    // resolves once the CONNECT request is sent; the error surfaces when
    // the orchestrator's next consumer pulls).
    const reader = result.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('407'),
    });
  });

  it('surfaces 502 Bad Gateway as a typed proxy-handshake error', async () => {
    const fake = makeFakeSocketDial();
    const result = await (async () => {
      const p = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
      const srv = await fake.awaitConnect();
      while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);
      srv.respond('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return await p;
    })();
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('502'),
    });
  });

  it('rejects malformed status lines as proxy-handshake', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    srv.respond('NOT-HTTP whatsoever\r\n\r\n');
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('bad status line'),
    });
  });

  it('caps the header buffer so a hostile proxy with no terminator cannot OOM the dialer', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    // 70 KiB of garbage with NO double-CRLF.
    const garbage = new Uint8Array(70 * 1024);
    garbage.fill(0x41);
    srv.respond(garbage);
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringMatching(/exceeded.*without a header terminator/),
    });
  });

  it('reports proxy-handshake when the server hangs up before any status', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    while (!new TextDecoder().decode(srv.peekWritten()).includes('\r\n\r\n')) await srv.read(1);

    srv.endResponse();
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toBeInstanceOf(ProxyDialError);
  });
});

// Shared helpers for the coverage matrix below.
const drainCONNECTRequest = async (srv: { peekWritten: () => Uint8Array; read: (n: number) => Promise<Uint8Array> }): Promise<string> => {
  const dec = new TextDecoder();
  let head = '';
  while (!head.includes('\r\n\r\n')) head += dec.decode(await srv.read(1), { stream: true });
  return head;
};

describe('dialHttpConnect — auth header encoding', () => {
  // RFC 7617 §2: token = base64(user-id ":" password). user-id MUST NOT
  // contain ":"; the spec doesn't mandate rejecting it, but the encoded
  // form would be ambiguous on the server side.
  it('encodes "user:pass" as "dXNlcjpwYXNz"', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(
      httpConfig({ username: 'user', password: 'pass' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    expect(head).toContain('Proxy-Authorization: Basic dXNlcjpwYXNz\r\n');
    srv.respond('HTTP/1.1 200 Connection Established\r\n\r\n');
    await promise;
  });

  it('encodes empty username + non-empty password as ":pass" → "OnBhc3M="', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(
      httpConfig({ username: '', password: 'pass' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    expect(head).toContain('Proxy-Authorization: Basic OnBhc3M=\r\n');
    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });

  it('treats username present + password undefined as username:""', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(
      httpConfig({ username: 'admin' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    // base64("admin:") = "YWRtaW46"
    expect(head).toContain('Proxy-Authorization: Basic YWRtaW46\r\n');
    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });

  // RFC 7617 §2.1 defaults the credential charset to UTF-8; the dialer
  // encodes the `${user}:${password}` string with TextEncoder and base64s
  // the resulting bytes.
  it('UTF-8 encodes a "ä" (U+00E4) password before base64 (RFC 7617 §2.1)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(
      httpConfig({ username: 'u', password: 'pä' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    // base64(UTF-8("u:pä")) = base64([0x75, 0x3a, 0x70, 0xc3, 0xa4]) =
    // "dTpww6Q=". A Latin-1 encoding would instead emit "dTpw5A=="; RFC
    // 7617 §2.1 mandates the UTF-8 form, so the encoder must
    // UTF-8-then-base64.
    expect(head).toContain('Proxy-Authorization: Basic dTpww6Q=\r\n');
    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });

  it('UTF-8 encodes a password with a high BMP code point (U+4E2D "中")', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(
      httpConfig({ username: 'u', password: 'p中' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    // base64(UTF-8("u:p中")) = base64([0x75, 0x3a, 0x70, 0xe4, 0xb8, 0xad])
    // = "dTpw5Lit". btoa() rejects code points > U+00FF, so the encoder
    // must UTF-8-then-base64 rather than feed the raw JS string.
    expect(head).toContain('Proxy-Authorization: Basic dTpw5Lit\r\n');
    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });

  it('UTF-8 encodes an emoji password (astral plane, U+1F600 "😀")', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(
      httpConfig({ username: 'u', password: '😀' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    // base64(UTF-8("u:😀")) = base64([0x75, 0x3a, 0xf0, 0x9f, 0x98, 0x80])
    // = "dTrwn5iA".
    expect(head).toContain('Proxy-Authorization: Basic dTrwn5iA\r\n');
    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });
});

describe('dialHttpConnect — request authority forms', () => {
  // RFC 9110 §9.3.6: CONNECT request-target is the authority form
  // host:port; for IPv6 literals the host MUST be wrapped in [...].
  it('uses the bare IPv4 literal in request-target and Host header', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), { host: '1.2.3.4', port: 443 }, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    expect(head).toContain('CONNECT 1.2.3.4:443 HTTP/1.1\r\n');
    expect(head).toContain('Host: 1.2.3.4:443\r\n');
    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });

  it('brackets a bare IPv6 literal in request-target and Host header', async () => {
    // DialTarget.host arrives WITHOUT the `[…]` envelope (see types.ts);
    // the CONNECT emitter is responsible for re-adding the brackets when
    // pushing the host back into a uri-host context (RFC 3986 §3.2.2).
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), { host: '2001:db8::1', port: 443 }, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    const head = await drainCONNECTRequest(srv);
    expect(head).toContain('CONNECT [2001:db8::1]:443 HTTP/1.1\r\n');
    expect(head).toContain('Host: [2001:db8::1]:443\r\n');
    srv.respond('HTTP/1.1 200 OK\r\n\r\n');
    await promise;
  });

  it('round-trips port 80 / 1 / 65535 verbatim', async () => {
    for (const port of [1, 80, 65535]) {
      const fake = makeFakeSocketDial();
      const promise = dialHttpConnect(httpConfig(), { host: 'h', port }, { socketDial: fake.socketDial });
      const srv = await fake.awaitConnect();
      const head = await drainCONNECTRequest(srv);
      expect(head).toContain(`CONNECT h:${port} HTTP/1.1\r\n`);
      srv.respond('HTTP/1.1 200 OK\r\n\r\n');
      await promise;
    }
  });

  it('rejects an IDN host string before any I/O — caller must punycode first', async () => {
    // RFC 9110 §5.4 requires Host to be a valid uri-host; Host is
    // request-line-derived. The CONNECT request-line and Host header
    // serialize as wire bytes and must be ASCII — straddling Latin-1
    // and UTF-8 here would make the line ambiguous to upstream
    // parsers. Reject up front and surface to the caller as a typed
    // dial error so it can punycode before retrying.
    const fake = makeFakeSocketDial();
    await expect(
      dialHttpConnect(httpConfig(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('ASCII'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});

describe('dialHttpConnect — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialHttpConnect(httpConfig(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('1..65535'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects an empty target host at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialHttpConnect(httpConfig(), { host: '', port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('empty'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  // CR/LF/SP/NUL/DEL inside the target host would split the CONNECT
  // request line as `${target.host}:${target.port}` and inject a forged
  // head onto the wire — same anti-smuggling defense the http package's
  // ws-upgrade and fetch-on-stream apply to their interpolated strings.
  it.each([
    ['CR', 'evil\r.example'],
    ['LF', 'evil\n.example'],
    ['SP', 'evil .example'],
    ['NUL', 'evil\0.example'],
    ['DEL', 'evil\x7f.example'],
  ])('rejects a target host containing %s at stage=config', async (_label, host) => {
    const fake = makeFakeSocketDial();
    await expect(
      dialHttpConnect(httpConfig(), { host, port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('forbidden byte'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});

describe('dialHttpConnect — response status code matrix', () => {
  // RFC 9110 §15.3.1: any 2xx is success; reason phrase is freeform.
  // RFC 9110 §15.5.4 & §15.5.7 define 407 / 504.
  const expectStatusError = async (statusLine: string, contains: string): Promise<void> => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await drainCONNECTRequest(srv);
    srv.respond(`${statusLine}\r\n\r\n`);
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining(contains),
    });
  };

  it('accepts 200 with a non-canonical reason phrase', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await drainCONNECTRequest(srv);
    srv.respond('HTTP/1.1 200 tunneled\r\n\r\n');
    await promise;
  });

  it('accepts HTTP/1.0 200', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await drainCONNECTRequest(srv);
    srv.respond('HTTP/1.0 200 OK\r\n\r\n');
    await promise;
  });

  it('accepts a 200 carrying a CONNECT-illegal Content-Length header without choking', async () => {
    // RFC 9110 §9.3.6: a 2xx CONNECT response must NOT carry a body. We
    // forward whatever follows the header terminator as opaque post-CONNECT
    // bytes without parsing chunked / content-length framing.
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await drainCONNECTRequest(srv);
    srv.respond('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nDATA');
    const result = await promise;
    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value!)).toBe('DATA');
  });

  it('rejects HTTP/2.0 status line — only HTTP/1.0 and HTTP/1.1 are supported', async () => {
    await expectStatusError('HTTP/2.0 200 OK', 'bad status line');
  });

  it('rejects 100 Continue — an interim status before 200 violates CONNECT framing', async () => {
    await expectStatusError('HTTP/1.1 100 Continue', '100');
  });

  it('rejects 301 Moved Permanently — 3xx is not a CONNECT success', async () => {
    await expectStatusError('HTTP/1.1 301 Moved Permanently', '301');
  });

  it('rejects 400 Bad Request', async () => {
    await expectStatusError('HTTP/1.1 400 Bad Request', '400');
  });

  it('rejects 403 Forbidden', async () => {
    await expectStatusError('HTTP/1.1 403 Forbidden', '403');
  });

  it('rejects 404 Not Found', async () => {
    await expectStatusError('HTTP/1.1 404 Not Found', '404');
  });

  it('rejects 504 Gateway Timeout', async () => {
    await expectStatusError('HTTP/1.1 504 Gateway Timeout', '504');
  });
});

describe('dialHttpConnect — malformed status lines', () => {
  it('rejects garbage that does not start with HTTP/', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await drainCONNECTRequest(srv);
    srv.respond('GET / HTTP/1.1\r\n\r\n');
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
    });
  });

  it('rejects a status line with a non-three-digit code', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await drainCONNECTRequest(srv);
    srv.respond('HTTP/1.1 20 OK\r\n\r\n');
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
    });
  });
});
