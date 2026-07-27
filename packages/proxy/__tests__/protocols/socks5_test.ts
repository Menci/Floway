import { describe, expect, it } from 'vitest';

import { buildSocks5ConnectRequest, dialSocks5 } from '../../src/protocols/socks5.ts';
import type { Socks5ProxyConfig } from '../../src/proxy-config.ts';
import type { DialOptions, DialTarget } from '../../src/types.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';

const target: DialTarget = { host: 'api.openai.com', port: 443 };

const socks5Config = (overrides: Partial<Socks5ProxyConfig> = {}): Socks5ProxyConfig => ({
  kind: 'socks5',
  host: 'proxy.example',
  port: 1080,
  name: 'p',
  ...overrides,
});

const arr = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

const expectEqualBytes = (got: Uint8Array, want: number[]): void => {
  expect(Array.from(got)).toEqual(want);
};

describe('dialSocks5 — RFC 1928 no-auth happy path', () => {
  it('writes greeting [0x05 0x01 0x00] and a domain-typed CONNECT request', async () => {
    const fake = makeFakeSocketDial();
    const opts: DialOptions = { socketDial: fake.socketDial };
    const promise = dialSocks5(socks5Config(), target, opts);
    const srv = await fake.awaitConnect();

    // 1) Greeting: VER=0x05, NMETHODS=0x01, METHOD=0x00 (no-auth).
    expectEqualBytes(await srv.read(3), [0x05, 0x01, 0x00]);
    srv.respond(arr(0x05, 0x00));

    // 2) CONNECT request:
    //    VER=0x05, CMD=0x01, RSV=0x00, ATYP=0x03,
    //    DOM_LEN=14, DOM='api.openai.com', PORT=0x01bb (443).
    const head = await srv.read(4);
    expectEqualBytes(head, [0x05, 0x01, 0x00, 0x03]);
    const lenBuf = await srv.read(1);
    expect(lenBuf[0]).toBe('api.openai.com'.length);
    const dom = await srv.read(lenBuf[0]!);
    expect(new TextDecoder().decode(dom)).toBe('api.openai.com');
    const port = await srv.read(2);
    expectEqualBytes(port, [0x01, 0xbb]);

    // 3) Reply: success with IPv4 BND.ADDR.
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00));

    const result = await promise;
    expect(result.readable).toBeInstanceOf(ReadableStream);

    // 4) Post-handshake bytes flow through transparently.
    srv.respond(arr(0xde, 0xad, 0xbe, 0xef));
    const reader = result.readable.getReader();
    const { value } = await reader.read();
    expectEqualBytes(value!, [0xde, 0xad, 0xbe, 0xef]);
  });
});

describe('dialSocks5 — RFC 1929 user/pass sub-negotiation', () => {
  it('offers methods 0x00 and 0x02, then runs the user/pass sub-negotiation when selected', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'user', password: 'pass' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();

    // Greeting offers no-auth + user/pass.
    expectEqualBytes(await srv.read(4), [0x05, 0x02, 0x00, 0x02]);
    // Server picks user/pass.
    srv.respond(arr(0x05, 0x02));

    // RFC 1929 sub-negotiation: VER=0x01, ULEN=4, 'user', PLEN=4, 'pass'.
    const subNeg = await srv.read(1 + 1 + 4 + 1 + 4);
    expectEqualBytes(subNeg, [
      0x01,
      0x04, ...new TextEncoder().encode('user'),
      0x04, ...new TextEncoder().encode('pass'),
    ]);
    srv.respond(arr(0x01, 0x00));

    // CONNECT request follows the same shape.
    await srv.read(4);
    const lenBuf = await srv.read(1);
    await srv.read(lenBuf[0]!);
    await srv.read(2);
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
    await promise;
  });

  it('rejects auth failure (status != 0x00) as a typed proxy-handshake error', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u', password: 'p' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    await srv.read(4); // greeting
    srv.respond(arr(0x05, 0x02));
    await srv.read(1 + 1 + 1 + 1 + 1); // sub-neg
    srv.respond(arr(0x01, 0x01)); // status=1 → failure

    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('auth failed'),
    });
  });

  it('rejects username longer than 255 bytes before any I/O', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u'.repeat(256), password: 'p' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    // Server must accept the greeting and pick user/pass for the dialer to
    // even get to the cred-too-long check.
    await srv.read(4);
    srv.respond(arr(0x05, 0x02));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      message: expect.stringContaining('cred too long'),
    });
  });
});

describe('dialSocks5 — failure modes', () => {
  it('rejects an "no acceptable methods" reply (0x05 0xff)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0xff));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('no acceptable methods'),
    });
  });

  it('handles ATYP=0x04 (IPv6) in the CONNECT reply by reading the 16-byte BND.ADDR', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await srv.read(4);
    const lenBuf = await srv.read(1);
    await srv.read(lenBuf[0]!);
    await srv.read(2);

    const ipv6 = new Uint8Array(16);
    const port = arr(0x00, 0x00);
    const reply = new Uint8Array([0x05, 0x00, 0x00, 0x04, ...ipv6, ...port]);
    srv.respond(reply);
    await promise;
  });

  it('rejects an unknown ATYP in the CONNECT reply', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await srv.read(4);
    const lenBuf = await srv.read(1);
    await srv.read(lenBuf[0]!);
    await srv.read(2);

    srv.respond(arr(0x05, 0x00, 0x00, 0x77));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('unknown ATYP'),
    });
  });
});

// Shared helpers for the coverage matrix below.

const drainConnectRequest = async (
  srv: { read: (n: number) => Promise<Uint8Array> },
): Promise<void> => {
  await srv.read(4);
  const lenBuf = await srv.read(1);
  await srv.read(lenBuf[0]!);
  await srv.read(2);
};

describe('dialSocks5 — RFC 1928 method-select negotiation', () => {
  // RFC 1928 §3: the server picks one method from the client's list, or
  // returns 0xff if none is acceptable. The client MUST close on 0xff.
  it('rejects a server-picked method we did not offer (e.g. 0x03 CHAP)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x03));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('unexpected method'),
    });
  });

  it('rejects a method-select reply with version != 0x05', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x04, 0x00));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('bad version in method-select'),
    });
  });

  it('offers only no-auth (0x05 0x01 0x00) when no credentials are configured', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    expectEqualBytes(await srv.read(3), [0x05, 0x01, 0x00]);
    srv.respond(arr(0x05, 0x00));
    await drainConnectRequest(srv);
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
    await promise;
  });

  it('happy-paths when the server picks no-auth even though user/pass was offered', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u', password: 'p' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    expectEqualBytes(await srv.read(4), [0x05, 0x02, 0x00, 0x02]);
    srv.respond(arr(0x05, 0x00));
    await drainConnectRequest(srv);
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
    await promise;
  });
});

describe('dialSocks5 — RFC 1929 user/pass length boundaries', () => {
  it('serializes a 1-byte username + 1-byte password correctly', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u', password: 'p' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    await srv.read(4);
    srv.respond(arr(0x05, 0x02));
    const subNeg = await srv.read(1 + 1 + 1 + 1 + 1);
    expectEqualBytes(subNeg, [
      0x01,
      0x01, 'u'.charCodeAt(0),
      0x01, 'p'.charCodeAt(0),
    ]);
    srv.respond(arr(0x01, 0x00));
    await drainConnectRequest(srv);
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
    await promise;
  });

  it('serializes a 255-byte username + 255-byte password (RFC 1929 max)', async () => {
    const fake = makeFakeSocketDial();
    const u = 'u'.repeat(255);
    const p = 'p'.repeat(255);
    const promise = dialSocks5(
      socks5Config({ username: u, password: p }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    await srv.read(4);
    srv.respond(arr(0x05, 0x02));
    // total: 1 (ver) + 1 (ulen) + 255 + 1 (plen) + 255 = 513
    const subNeg = await srv.read(1 + 1 + 255 + 1 + 255);
    expect(subNeg[0]).toBe(0x01);
    expect(subNeg[1]).toBe(0xff);
    expect(subNeg[1 + 1 + 255]).toBe(0xff);
    srv.respond(arr(0x01, 0x00));
    await drainConnectRequest(srv);
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
    await promise;
  });

  it('rejects a 256-byte password before any I/O', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u', password: 'p'.repeat(256) }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    await srv.read(4);
    srv.respond(arr(0x05, 0x02));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      message: expect.stringContaining('cred too long'),
    });
  });

  it('rejects an auth-subneg reply with version != 0x01', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(
      socks5Config({ username: 'u', password: 'p' }),
      target,
      { socketDial: fake.socketDial },
    );
    const srv = await fake.awaitConnect();
    await srv.read(4);
    srv.respond(arr(0x05, 0x02));
    await srv.read(1 + 1 + 1 + 1 + 1);
    srv.respond(arr(0x02, 0x00));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('auth bad version'),
    });
  });
});

describe('dialSocks5 — CONNECT request address encoding', () => {
  it('encodes port 0x0050 (80) and 0xffff (65535) in network byte order', async () => {
    for (const port of [80, 65535]) {
      const fake = makeFakeSocketDial();
      const promise = dialSocks5(socks5Config(), { host: 'h', port }, { socketDial: fake.socketDial });
      const srv = await fake.awaitConnect();
      await srv.read(3);
      srv.respond(arr(0x05, 0x00));
      await srv.read(4);
      await srv.read(1);
      await srv.read('h'.length);
      const portBytes = await srv.read(2);
      expectEqualBytes(portBytes, [(port >> 8) & 0xff, port & 0xff]);
      srv.respond(arr(0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0));
      await promise;
    }
  });
});

describe('buildSocks5ConnectRequest — ATYP discrimination', () => {
  // RFC 1928 §4 defines ATYP=0x01 (4 raw v4 octets), 0x03 (length-prefixed
  // domain), 0x04 (16 raw v6 octets). Reference clients (Xray-core,
  // sing-box) emit the literal ATYP for literal targets rather than
  // forcing the server to re-parse a string into an address.
  it('emits ATYP=0x01 + 4 octets for an IPv4 literal target', () => {
    const out = buildSocks5ConnectRequest('1.2.3.4', 80);
    expectEqualBytes(out, [0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50]);
  });

  it('emits ATYP=0x04 + 16 octets for an IPv6 literal target', () => {
    const out = buildSocks5ConnectRequest('2001:db8::1', 443);
    expect(out[3]).toBe(0x04);
    expectEqualBytes(out.subarray(4, 20), [
      0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
    ]);
    expectEqualBytes(out.subarray(20, 22), [0x01, 0xbb]);
  });

  it('still emits ATYP=0x03 for a true hostname', () => {
    const out = buildSocks5ConnectRequest('example.com', 443);
    expectEqualBytes(out.subarray(0, 5), [0x05, 0x01, 0x00, 0x03, 11]);
    expect(new TextDecoder().decode(out.subarray(5, 16))).toBe('example.com');
    expectEqualBytes(out.subarray(16, 18), [0x01, 0xbb]);
  });
});

describe('dialSocks5 — RFC 1928 §6 reply field codes', () => {
  // Each rep code surfaces as a typed proxy-handshake error carrying the
  // numeric rep in the message ("status=N").
  const REP_CODES: Array<[number, string]> = [
    [0x01, 'general'],
    [0x02, 'not allowed by ruleset'],
    [0x03, 'network unreachable'],
    [0x04, 'host unreachable'],
    [0x05, 'connection refused'],
    [0x06, 'TTL expired'],
    [0x07, 'command not supported'],
    [0x08, 'address type not supported'],
  ];

  for (const [code, label] of REP_CODES) {
    it(`surfaces rep=0x${code.toString(16).padStart(2, '0')} (${label}) as proxy-handshake status=${code}`, async () => {
      const fake = makeFakeSocketDial();
      const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
      const srv = await fake.awaitConnect();
      await srv.read(3);
      srv.respond(arr(0x05, 0x00));
      await drainConnectRequest(srv);
      srv.respond(new Uint8Array([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      await expect(promise).rejects.toMatchObject({
        name: 'ProxyDialError',
        stage: 'proxy-handshake',
        message: expect.stringContaining(`status=${code}`),
      });
    });
  }
});

describe('dialSocks5 — CONNECT reply BND.ADDR variants', () => {
  // RFC 1928 §6: the reply BND.ADDR is the address the proxy bound on our
  // behalf. We parse-and-discard it.
  it('handles ATYP=0x01 (IPv4) BND.ADDR', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await drainConnectRequest(srv);
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 1, 2, 3, 4, 0x12, 0x34));
    await promise;
  });

  it('handles ATYP=0x03 (domain) BND.ADDR with a length prefix', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await drainConnectRequest(srv);
    const dom = new TextEncoder().encode('local');
    srv.respond(new Uint8Array([0x05, 0x00, 0x00, 0x03, dom.byteLength, ...dom, 0, 0]));
    await promise;
  });

  it('rejects ATYP=0x04 (IPv6) BND.ADDR when RSV byte is non-zero (RFC 1928 §6)', async () => {
    // RFC 1928 §6 says RSV MUST be 0x00. A non-zero byte is a spec
    // violation and we'd rather surface that than silently parse an
    // ambiguous reply.
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await drainConnectRequest(srv);
    const ipv6 = new Uint8Array(16);
    srv.respond(new Uint8Array([0x05, 0x00, 0xff, 0x04, ...ipv6, 0, 0]));
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('RSV byte non-zero'),
    });
  });
});

describe('dialSocks5 — pre-handshake EOF / mid-flow errors', () => {
  it('rejects an EOF after the greeting reply but before the CONNECT reply', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await drainConnectRequest(srv);
    srv.endResponse();
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('unexpected EOF'),
    });
  });

  it('rejects an EOF mid-greeting', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05));
    srv.endResponse();
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('unexpected EOF'),
    });
  });

  it('rejects a CONNECT reply mid-BND.ADDR (truncated IPv4)', async () => {
    const fake = makeFakeSocketDial();
    const promise = dialSocks5(socks5Config(), target, { socketDial: fake.socketDial });
    const srv = await fake.awaitConnect();
    await srv.read(3);
    srv.respond(arr(0x05, 0x00));
    await drainConnectRequest(srv);
    // 4-byte head + only 2 of the 4 IPv4 bytes, then EOF.
    srv.respond(arr(0x05, 0x00, 0x00, 0x01, 1, 2));
    srv.endResponse();
    await expect(promise).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'proxy-handshake',
      message: expect.stringContaining('unexpected EOF'),
    });
  });

  it('classifies tcp-connect failures with the underlying cause', async () => {
    const fake = makeFakeSocketDial();
    fake.failNextConnect(new Error('ECONNREFUSED'));
    await expect(
      dialSocks5(socks5Config(), target, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('tcp connect to proxy.example:1080 failed'),
    });
  });
});

describe('dialSocks5 — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialSocks5(socks5Config(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('1..65535'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a non-ASCII target host at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialSocks5(socks5Config(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('ASCII'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects an empty target host at stage=config, before any TCP connect', async () => {
    // ATYP=domain framing would otherwise emit a zero-length length-prefixed
    // domain, which strict upstreams reject opaquely after the TCP slot has
    // already burned.
    const fake = makeFakeSocketDial();
    await expect(
      dialSocks5(socks5Config(), { host: '', port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('empty'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a 256-byte target host at stage=config, before any TCP connect', async () => {
    // ATYP=domain framing puts the host behind a 1-byte length prefix
    // (max 255). The pre-dial assertion catches an overflow before a
    // TCP slot has been burned to the proxy — without it the length
    // byte would silently truncate and corrupt the address frame.
    const fake = makeFakeSocketDial();
    await expect(
      dialSocks5(socks5Config(), { host: 'a'.repeat(256), port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('too long'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});
