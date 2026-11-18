import { describe, expect, it, vi } from 'vitest';

import { dial, runDirectConnectRequest, runProxiedRequest } from '../src/dialer.ts';
import { dialSocks5 } from '../src/protocols/socks5.ts';
import type { ProxyConfig } from '../src/proxy-config.ts';
import type { DialOptions, DialResult, ProxyRequestTarget, SocketDial } from '../src/types.ts';

const noopStream = (): DialResult => {
  const readable = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const writable = new WritableStream<Uint8Array>();
  return { readable, writable };
};

vi.mock('../src/protocols/socks5.ts', () => ({
  dialSocks5: vi.fn(async () => noopStream()),
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
  startTls: async () => {
    throw new Error('stub socket dial — tests should not reach here');
  },
};

const baseOptions = (): DialOptions => ({ socketDial: stubSocketDial });

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
});

describe('runProxiedRequest — post-dial teardown', () => {
  it('cancels the dialed readable when the inner-TLS step throws past the dial', async () => {
    // Track every cancel attempt directly on the readable so the assertion
    // doesn't depend on cancel-hook semantics (the hook doesn't fire once
    // the underlying source is already done or errored).
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
      runProxiedRequest(config, target, { method: 'GET', path: '/', headers: [] }, baseOptions()),
    ).rejects.toBeInstanceOf(Error);
    expect(cancelCalls).toBeGreaterThan(0);
    expect(lastCancelReason).toBeInstanceOf(Error);
  });
});

describe('runDirectConnectRequest', () => {
  const makeSocketDial = (responseHead: string, connect: () => void = () => {}, startTls = vi.fn(async () => noopStream())): {
    socketDial: SocketDial;
    written: () => string;
    closeCalls: () => number;
    startTls: ReturnType<typeof vi.fn>;
  } => {
    let writeBuf = new Uint8Array(0);
    let closes = 0;
    return {
      written: () => new TextDecoder().decode(writeBuf),
      closeCalls: () => closes,
      startTls,
      socketDial: {
        startTls,
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
      { method: 'POST', path: '/responses?stream=1', headers: [], body: new TextEncoder().encode('body') },
      { socketDial: direct.socketDial },
    );

    expect(await response.text()).toBe('ok');
    expect(direct.written()).toContain('POST /responses?stream=1 HTTP/1.1\r\n');
    expect(direct.written()).toContain('Host: api.example.com\r\n');
    expect(direct.written()).toContain('Content-Length: 4\r\n');
    expect(direct.written().endsWith('\r\n\r\nbody')).toBe(true);
    expect(direct.closeCalls()).toBe(1);
  });

  // addEventListener on an already-aborted signal never fires, so the abort
  // that lands while the request is in flight has to be picked up synchronously.
  it('closes its socket when the caller aborted while the request was in flight', async () => {
    const controller = new AbortController();
    // Abort once the socket exists but before the response is handed back, so
    // the dial itself still succeeds and the abort lands in the window the
    // listener install would otherwise miss.
    const direct = makeSocketDial('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok', () => controller.abort('client gone'));
    await runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: [] },
      { socketDial: direct.socketDial, signal: controller.signal },
    );

    expect(direct.closeCalls()).toBe(1);
  });

  it('passes an IPv4 literal through as both the TLS host and verification identity', async () => {
    const cause = new Error('certificate rejected');
    const direct = makeSocketDial('', () => {}, vi.fn(async () => { throw cause; }));

    const failure = runDirectConnectRequest(
      { host: '192.0.2.10', port: 443, tls: true },
      { method: 'GET', path: '/v1/models', headers: [] },
      { socketDial: direct.socketDial },
    );

    await expect(failure).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'inner-tls',
      cause,
    });
    expect(direct.startTls).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        host: '192.0.2.10',
        verifyHost: '192.0.2.10',
      }),
    );
    expect(direct.closeCalls()).toBe(1);
  });
});

// Exercises the Host header that runProxiedRequest synthesises when the
// caller leaves it out — RFC 9110 §7.2 wants `host[:port]` with the port
// dropped only when it equals the scheme's default. The dial layer is
// mocked to return a duplex whose write-side captures the request line +
// headers; the canned response keeps fetchOnStream from hanging.
//
// All cases pin target.tls=false to keep the test off the TLS upgrade, which
// won't complete a handshake against a canned response stream. The
// port=443 + tls=false case proves the default-port lookup keys on tls.
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

  it('includes the port when the upstream is plain HTTP on 443 (non-default for tls=false)', async () => {
    // 443 is HTTPS's default port; on the plain (tls=false) path it's
    // non-default. The Host header must reflect that — strict virtual-host
    // upstreams route on the literal `host:port` value.
    const cap = buildCapturingDial(ok200);
    cap.setupMock();
    await runProxiedRequest(
      socks,
      { host: 'api.example.com', port: 443, tls: false },
      { method: 'GET', path: '/', headers: [] },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: api.example.com:443\r\n');
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
      { method: 'GET', path: '/', headers: [] },
      baseOptions(),
    );
    expect(cap.written()).toContain('Host: [2001:db8::1]:8080\r\n');
  });
});
