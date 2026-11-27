import { once } from 'node:events';
import net from 'node:net';
import { Duplex } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { dial, runDirectConnectRequest, runProxiedRequest } from '../src/dialer.ts';
import { dialSocks5 } from '../src/protocols/socks5.ts';
import type { ProxyConfig } from '../src/proxy-config.ts';
import type { DialOptions, DialResult, ProxyRequestTarget, SocketDial } from '../src/types.ts';
import { HttpTransportError } from '@floway-dev/http';

const noopStream = (): DialResult => {
  const readable = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
  const writable = new WritableStream<Uint8Array>();
  return { readable, writable, close: async () => {} };
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
      return { readable, writable, close: async () => {} };
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
  const makeSocketDial = (responseHead: string, {
    connect = () => {},
    startTls = vi.fn(async () => noopStream()),
    close = async () => {},
  }: { connect?: () => void; startTls?: SocketDial['startTls']; close?: () => Promise<void> } = {}): {
    socketDial: SocketDial;
    written: () => string;
    closeCalls: () => number;
    startTls: SocketDial['startTls'];
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
            close: async () => { closes++; await close(); },
          };
        },
      },
    };
  };

  it('sends HTTP directly to the target and closes its socket after the body ends', async () => {
    const direct = makeSocketDial('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-Upstream: one\r\nX-Upstream: two\r\n\r\nok');
    const response = await runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'POST', path: '/responses?stream=1', headers: [], body: new TextEncoder().encode('body') },
      { socketDial: direct.socketDial },
    );

    expect(await response.text()).toBe('ok');
    expect(response.headerLines?.filter(([name]) => name.toLowerCase() === 'x-upstream')).toEqual([
      ['X-Upstream', 'one'], ['X-Upstream', 'two'],
    ]);
    expect(direct.written()).toContain('POST /responses?stream=1 HTTP/1.1\r\n');
    expect(direct.written()).toContain('Host: api.example.com\r\n');
    expect(direct.written()).toContain('Content-Length: 4\r\n');
    expect(direct.written().endsWith('\r\n\r\nbody')).toBe(true);
    expect(direct.closeCalls()).toBe(1);
  });

  it('propagates the original socket close failure before reporting body completion', async () => {
    const bug = new TypeError('socket close invariant failed');
    const direct = makeSocketDial('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx', { close: async () => { throw bug; } });
    const response = await runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: [] },
      { socketDial: direct.socketDial },
    );
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toEqual({ done: false, value: new Uint8Array([120]) });
    await expect(reader.read()).rejects.toBe(bug);
    expect(direct.closeCalls()).toBe(1);
  });

  it('propagates a close failure before delivering a bodyless response', async () => {
    const bug = new TypeError('socket close invariant failed');
    const direct = makeSocketDial('HTTP/1.1 204 No Content\r\n\r\n', { close: async () => { throw bug; } });
    await expect(runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: [] },
      { socketDial: direct.socketDial },
    )).rejects.toBe(bug);
    expect(direct.closeCalls()).toBe(1);
  });

  it('preserves a body framing failure when socket cleanup also rejects', async () => {
    const direct = makeSocketDial('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx', {
      close: async () => { throw new TypeError('socket close invariant failed'); },
    });
    const response = await runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: [] },
      { socketDial: direct.socketDial },
    );
    await expect(response.text()).rejects.toMatchObject({ code: 'EOF' });
    expect(direct.closeCalls()).toBe(1);
  });

  it('closes an acquired socket if the caller aborted during handoff', async () => {
    const controller = new AbortController();
    const reason = new Error('client gone');
    const direct = makeSocketDial('', { connect: () => controller.abort(reason) });
    const response = runDirectConnectRequest(
      { host: 'api.example.com', port: 80, tls: false },
      { method: 'GET', path: '/', headers: [] },
      { socketDial: direct.socketDial, signal: controller.signal },
    );

    await expect(response).rejects.toBe(reason);
    expect(direct.written()).toBe('');
    expect(direct.closeCalls()).toBe(1);
  });

  it('passes an IPv4 literal through as both the TLS host and verification identity', async () => {
    const cause = new HttpTransportError(new Error('certificate rejected'));
    const direct = makeSocketDial('', { startTls: vi.fn(async () => { throw cause; }) });

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

  it.each(['headers', 'body'] as const)('interrupts a live TCP exchange while awaiting %s', async phase => {
    const received = Promise.withResolvers<void>();
    const peerClosed = Promise.withResolvers<void>();
    let peer: net.Socket | undefined;
    const server = net.createServer({ allowHalfOpen: false }, socket => {
      peer = socket;
      socket.on('error', () => {});
      socket.once('close', () => peerClosed.resolve());
      socket.once('data', () => {
        if (phase === 'body') socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nx');
        received.resolve();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected a loopback TCP address');

    const socketDial: SocketDial = {
      ...stubSocketDial,
      async connect(host, port, opts) {
        const socket = net.connect({ host, port });
        const abort = (): void => { socket.destroy(opts?.signal?.reason as Error); };
        opts?.signal?.addEventListener('abort', abort, { once: true });
        const closed = new Promise<void>(resolve => socket.once('close', () => {
          opts?.signal?.removeEventListener('abort', abort);
          resolve();
        }));
        await once(socket, 'connect');
        const { readable, writable } = Duplex.toWeb(socket);
        return {
          readable: readable as ReadableStream<Uint8Array>, writable,
          close: async () => { socket.destroy(); await closed; },
        };
      },
    };
    try {
      const caller = new AbortController();
      const reason = new Error(`cancel while awaiting ${phase}`);
      const dialTimeoutMs = 100;
      const response = runDirectConnectRequest(
        { host: address.address, port: address.port, tls: false },
        { method: 'GET', path: '/', headers: [] },
        { socketDial, signal: caller.signal, dialTimeoutMs },
      );
      let blocked: Promise<unknown> = response;
      if (phase === 'body') {
        const reader = (await response).body!.getReader();
        expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([120]) });
        blocked = reader.read();
      }
      const rejected = expect(blocked).rejects.toBe(reason);
      await received.promise;
      if (phase === 'headers') await new Promise(resolve => setTimeout(resolve, dialTimeoutMs + 20));
      caller.abort(reason);
      await rejected;
      await peerClosed.promise;
    } finally {
      peer?.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
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
          return { readable, writable, close: async () => {} };
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
