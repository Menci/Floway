import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dial, runDirectConnectRequest, runProxiedRequest } from './dialer.ts';
import { dialHttpConnect } from './protocols/http-connect.ts';
import { dialReality } from './protocols/reality.ts';
import { dialShadowsocks2022 } from './protocols/shadowsocks-2022.ts';
import { dialShadowsocks } from './protocols/shadowsocks.ts';
import { dialSocks5 } from './protocols/socks5.ts';
import { dialTrojan } from './protocols/trojan.ts';
import { dialVlessTcpTls, dialVlessWsTls } from './protocols/vless.ts';
import type { ProxyConfig } from './proxy-config.ts';
import type { DialOptions, DialResult, ProxyRequestTarget, SocketDial } from './types.ts';

const noopStream = (): DialResult => {
  const readable = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const writable = new WritableStream<Uint8Array>();
  return { readable, writable };
};

vi.mock('./protocols/http-connect.ts', () => ({
  dialHttpConnect: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/socks5.ts', () => ({
  dialSocks5: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/trojan.ts', () => ({
  dialTrojan: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/vless.ts', () => ({
  dialVlessTcpTls: vi.fn(async () => noopStream()),
  dialVlessWsTls: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/shadowsocks.ts', () => ({
  dialShadowsocks: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/shadowsocks-2022.ts', () => ({
  dialShadowsocks2022: vi.fn(async () => noopStream()),
}));
vi.mock('./protocols/reality.ts', () => ({
  dialReality: vi.fn(async () => noopStream()),
}));

const target: ProxyRequestTarget = {
  host: 'api.openai.com',
  port: 443,
  tls: true,
};

const stubSocketDial: SocketDial = {
  connect: async () => {
    throw new Error('stub socket dial — tests should not reach here');
  },
};

const baseOptions = (): DialOptions => ({ socketDial: stubSocketDial });

const cases: Array<[ProxyConfig['kind'], ProxyConfig, ReturnType<typeof vi.fn>]> = [
  ['http', { kind: 'http', tls: false, host: 'h', port: 1, name: 'h' }, vi.mocked(dialHttpConnect)],
  ['socks5', { kind: 'socks5', host: 'h', port: 1, name: 'h' }, vi.mocked(dialSocks5)],
  ['trojan', { kind: 'trojan', password: 'p', host: 'h', port: 1, name: 'h' }, vi.mocked(dialTrojan)],
  ['vless-tcp', { kind: 'vless-tcp', uuid: 'u', host: 'h', port: 1, name: 'h' }, vi.mocked(dialVlessTcpTls)],
  ['vless-ws', { kind: 'vless-ws', uuid: 'u', host: 'h', port: 1, path: '/', name: 'h' }, vi.mocked(dialVlessWsTls)],
  ['ss', { kind: 'ss', method: 'aes-256-gcm', password: 'p', host: 'h', port: 1, name: 'h' }, vi.mocked(dialShadowsocks)],
  ['ss2022', { kind: 'ss2022', method: '2022-blake3-aes-128-gcm', passwordBase64: 'a', host: 'h', port: 1, name: 'h' }, vi.mocked(dialShadowsocks2022)],
  ['reality', { kind: 'reality', uuid: 'u', publicKey: 'p', serverName: 's', host: 'h', port: 1, name: 'h' }, vi.mocked(dialReality)],
];

const allDialerMocks = [
  vi.mocked(dialHttpConnect),
  vi.mocked(dialSocks5),
  vi.mocked(dialTrojan),
  vi.mocked(dialVlessTcpTls),
  vi.mocked(dialVlessWsTls),
  vi.mocked(dialShadowsocks),
  vi.mocked(dialShadowsocks2022),
  vi.mocked(dialReality),
];

describe('dial dispatch', () => {
  beforeEach(() => {
    for (const m of allDialerMocks) m.mockClear();
  });

  it.each(cases)('routes kind=%s only to its dialer', async (_kind, config, expectedDialer) => {
    await dial(config, target, baseOptions());
    expect(expectedDialer).toHaveBeenCalledTimes(1);
    for (const m of allDialerMocks) {
      if (m !== expectedDialer) expect(m).not.toHaveBeenCalled();
    }
  });
});

describe('dial deadline', () => {
  it('rejects with a tcp-connect ProxyDialError when the per-call timeout fires', async () => {
    // Wire socks5 to a dialer that never resolves so only the deadline can
    // unstick the call. The dial wrapper's combined controller signals abort
    // through to dispatch on timeout.
    vi.mocked(dialSocks5).mockImplementationOnce(async (_c, _t, opts) => {
      // Hold open until the caller signal aborts; reject with the abort
      // reason so the dial wrapper can surface the deadline error.
      await new Promise<DialResult>((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason ?? new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    });
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      dial(config, target, { ...baseOptions(), dialTimeoutMs: 50 }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('exceeded deadline'),
    });
  });

  it('rethrows the caller-driven AbortError when the external signal aborts mid-dial', async () => {
    vi.mocked(dialSocks5).mockImplementationOnce(async (_c, _t, opts) => {
      await new Promise<DialResult>((_, reject) => {
        opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason ?? new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    });
    const ac = new AbortController();
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    setTimeout(() => ac.abort(new DOMException('client gone', 'AbortError')), 30);
    await expect(
      dial(config, target, { ...baseOptions(), signal: ac.signal, dialTimeoutMs: 5_000 }),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'client gone' });
  });

  it('refuses to dial when the caller signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new DOMException('already gone', 'AbortError'));
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      dial(config, target, { ...baseOptions(), signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('runProxiedRequest — post-dial teardown', () => {
  it('cancels the dialed readable when the inner-TLS step throws past the dial', async () => {
    // Track every cancel attempt directly on the readable so the assertion
    // doesn't depend on cancel-hook semantics (the hook doesn't fire once
    // the underlying source is already done/errored, which userspaceTls's
    // pump leaves the EOFed source in by the time the catch runs).
    let cancelCalls = 0;
    let lastCancelReason: unknown = undefined;
    vi.mocked(dialSocks5).mockImplementationOnce(async () => {
      const inner = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
      const readable = new Proxy(inner, {
        get(t, prop, recv) {
          if (prop === 'cancel') {
            return (reason: unknown) => {
              cancelCalls++;
              lastCancelReason = reason;
              return Reflect.get(t, prop, recv).call(t, reason);
            };
          }
          return Reflect.get(t, prop, recv);
        },
      });
      const writable = new WritableStream<Uint8Array>();
      return { readable, writable };
    });
    const config: ProxyConfig = { kind: 'socks5', host: 'h', port: 1, name: 'h' };
    await expect(
      runProxiedRequest(config, target, { method: 'GET', path: '/', headers: {} }, baseOptions()),
    ).rejects.toBeInstanceOf(Error);
    expect(cancelCalls).toBeGreaterThan(0);
    expect(lastCancelReason).toBeInstanceOf(Error);
  });
});

describe('runDirectConnectRequest', () => {
  const makeSocketDial = (responseHead: string, connect: () => void = () => {}): {
    socketDial: SocketDial;
    written: () => string;
    closeCalls: () => number;
  } => {
    let writeBuf = new Uint8Array(0);
    let closes = 0;
    return {
      written: () => new TextDecoder().decode(writeBuf),
      closeCalls: () => closes,
      socketDial: {
        connect: async () => {
          connect();
          return {
            writable: new WritableStream<Uint8Array>({
              write(chunk) {
                const next = new Uint8Array(writeBuf.byteLength + chunk.byteLength);
                next.set(writeBuf, 0);
                next.set(chunk, writeBuf.byteLength);
                writeBuf = next;
              },
            }),
            readable: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(responseHead));
                controller.close();
              },
            }),
            close: async () => { closes++; },
          };
        },
      },
    };
  };

  it('sends HTTP directly to the target and closes its socket after the body ends', async () => {
    const direct = makeSocketDial('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    const response = await runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'POST', path: '/responses?stream=1', headers: {}, body: new TextEncoder().encode('body') },
      { socketDial: direct.socketDial },
    );

    expect(await response.text()).toBe('ok');
    expect(direct.written()).toContain('POST /responses?stream=1 HTTP/1.1\r\n');
    expect(direct.written()).toContain('Host: api.example.com\r\n');
    expect(direct.written()).toContain('Content-Length: 4\r\n');
    expect(direct.written().endsWith('\r\n\r\nbody')).toBe(true);
    expect(direct.closeCalls()).toBe(1);
  });

  it('closes its socket when the response body is cancelled', async () => {
    const direct = makeSocketDial('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    const response = await runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: {} },
      { socketDial: direct.socketDial },
    );

    await response.body!.cancel('client gone');
    expect(direct.closeCalls()).toBe(1);
  });

  it('closes its socket when the response body errors', async () => {
    const direct = makeSocketDial('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n');
    const response = await runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: {} },
      { socketDial: direct.socketDial },
    );

    await expect(response.text()).rejects.toThrow('upstream EOF');
    expect(direct.closeCalls()).toBe(1);
  });

  it('bounds the raw TCP connect with the direct-connect dial deadline', async () => {
    const socketDial: SocketDial = {
      connect: async (_host, _port, options) => {
        return await new Promise<never>((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        });
      },
    };

    await expect(runDirectConnectRequest(
      { host: 'api.example.com', port: 443, tls: true },
      { method: 'GET', path: '/', headers: {} },
      { socketDial, dialTimeoutMs: 20 },
    )).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'tcp-connect',
      message: expect.stringContaining('direct-connect'),
    });
  });
});

// Exercises the Host header that runProxiedRequest synthesises when the
// caller leaves it out — RFC 9110 §7.2 wants `host[:port]` with the port
// dropped only when it equals the scheme's default. The dial layer is
// mocked to return a duplex whose write-side captures the request line +
// headers; the canned response keeps fetchOnStream from hanging.
//
// All cases pin target.tls=false to keep the test off userspaceTls, which
// won't complete a handshake against a canned response stream. We cover
// the tls=false default branch (port 80 → omit) and the non-default branch
// (port 8080 → include); the tls=true default branch (port 443 → omit)
// shares the same `target.tls ? 443 : 80` lookup, indirectly verified by
// the port=443 + tls=false case which proves the lookup keys on tls.
describe('runProxiedRequest — Host header synthesis', () => {
  const buildCapturingDial = (responseHead: string): {
    written: () => string;
    setupMock: () => void;
  } => {
    let writeBuf = new Uint8Array(0);
    return {
      written: () => new TextDecoder().decode(writeBuf),
      setupMock: () => {
        vi.mocked(dialSocks5).mockImplementationOnce(async () => {
          const writable = new WritableStream<Uint8Array>({
            write(chunk) {
              const next = new Uint8Array(writeBuf.byteLength + chunk.byteLength);
              next.set(writeBuf, 0);
              next.set(chunk, writeBuf.byteLength);
              writeBuf = next;
            },
          });
          const readable = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode(responseHead));
              c.close();
            },
          });
          return { readable, writable };
        });
      },
    };
  };

  const socks: ProxyConfig = { kind: 'socks5', host: 'p', port: 1, name: 'p' };
  const ok200 = 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n';

  it('omits the port for plain HTTP on 80 (scheme default)', async () => {
    const cap = buildCapturingDial(ok200);
    cap.setupMock();
    await runProxiedRequest(
      socks,
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: {} },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: api.example.com\r\n');
  });

  it('includes the port for plain HTTP on 8080 (non-default port)', async () => {
    const cap = buildCapturingDial(ok200);
    cap.setupMock();
    await runProxiedRequest(
      socks,
      { host: 'api.example.com', port: 8080, tls: false },
      { method: 'GET', path: '/', headers: {} },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: api.example.com:8080\r\n');
  });

  it('includes the port when the upstream is plain HTTP on 443 (non-default for tls=false)', async () => {
    // 443 is HTTPS's default port; on the plain (tls=false) path it's
    // non-default. The Host header must reflect that — strict virtual-host
    // upstreams route on the literal `host:port` value.
    const cap = buildCapturingDial(ok200);
    cap.setupMock();
    await runProxiedRequest(
      socks,
      { host: 'api.example.com', port: 443, tls: false },
      { method: 'GET', path: '/', headers: {} },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: api.example.com:443\r\n');
  });

  it('preserves a caller-provided Host header verbatim', async () => {
    const cap = buildCapturingDial(ok200);
    cap.setupMock();
    await runProxiedRequest(
      socks,
      { host: 'cdn.example.com', port: 443, tls: false },
      { method: 'GET', path: '/', headers: { Host: 'origin.example.com:9000' } },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: origin.example.com:9000\r\n');
  });

  it('wraps an IPv6 literal target in its uri-host envelope (RFC 3986 §3.2.2)', async () => {
    // Per the `DialTarget.host` contract IPv6 literals arrive without the
    // `[…]` envelope; the Host-header synth re-adds them so the value parses
    // as a uri-host. Without the envelope, `2001:db8::1:443` reads as a
    // hostname "2001" with port "db8::1:443" and strict upstreams 400.
    const cap = buildCapturingDial(ok200);
    cap.setupMock();
    await runProxiedRequest(
      socks,
      { host: '2001:db8::1', port: 8080, tls: false },
      { method: 'GET', path: '/', headers: {} },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: [2001:db8::1]:8080\r\n');
  });

  it('wraps an IPv6 literal target without a port suffix when the port matches the scheme default', async () => {
    const cap = buildCapturingDial(ok200);
    cap.setupMock();
    await runProxiedRequest(
      socks,
      { host: '::1', port: 80, tls: false },
      { method: 'GET', path: '/', headers: {} },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: [::1]\r\n');
  });
});
