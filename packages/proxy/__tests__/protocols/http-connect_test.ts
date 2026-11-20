import { describe, expect, it } from 'vitest';

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

describe('dialHttpConnect — failure modes', () => {
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
    });
  });
});

const drainCONNECTRequest = async (srv: { peekWritten: () => Uint8Array; read: (n: number) => Promise<Uint8Array> }): Promise<string> => {
  const dec = new TextDecoder();
  let head = '';
  while (!head.includes('\r\n\r\n')) head += dec.decode(await srv.read(1), { stream: true });
  return head;
};

describe('dialHttpConnect — request authority forms', () => {
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
});

describe('dialHttpConnect — response status code matrix', () => {
  const expectStatusError = async (statusLine: string): Promise<void> => {
    const fake = makeFakeSocketDial();
    const promise = dialHttpConnect(httpConfig(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await drainCONNECTRequest(srv);
    srv.respond(`${statusLine}\r\n\r\n`);
    const result = await promise;
    await expect(result.readable.getReader().read()).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
    });
  };

  it('rejects 100 Continue — an interim status before 200 violates CONNECT framing', async () => {
    await expectStatusError('HTTP/1.1 100 Continue');
  });
});
