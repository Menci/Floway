import { afterEach, describe, expect, it, vi } from 'vitest';

import { cloudflareSocketDial } from '../src/socket-dial.ts';
import { installCloudflareConnect, resetCloudflareConnect } from './test-utils/cloudflare-sockets-stub.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

class FakeSocket {
  readonly readable = new ReadableStream<Uint8Array>();
  readonly writable = new WritableStream<Uint8Array>();
  readonly openedState = deferred<{ remoteAddress?: string; localAddress?: string }>();
  readonly closedState = deferred<void>();
  readonly opened = this.openedState.promise;
  readonly closed = this.closedState.promise;
  closeCalls = 0;
  closeError: Error | null = null;
  rejectOpenOnClose: Error | null = null;

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.rejectOpenOnClose) this.openedState.reject(this.rejectOpenOnClose);
    this.closedState.resolve();
    if (this.closeError) throw this.closeError;
  }
}

afterEach(() => {
  resetCloudflareConnect();
  vi.restoreAllMocks();
});

describe('cloudflareSocketDial', () => {
  it('normalizes hosts and maps plain and TLS connection options', async () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    for (const socket of sockets) socket.openedState.resolve({});
    const calls: Array<{ address: { hostname: string; port: number }; options: unknown }> = [];
    installCloudflareConnect((address, options) => {
      calls.push({ address, options });
      return sockets.shift()!;
    });

    const plain = await cloudflareSocketDial.connect('[2001:db8::1]', 80);
    const tls = await cloudflareSocketDial.connect('example.com', 443, { tls: true });

    expect(calls).toEqual([
      {
        address: { hostname: '2001:db8::1', port: 80 },
        options: { allowHalfOpen: true, secureTransport: 'off' },
      },
      {
        address: { hostname: 'example.com', port: 443 },
        options: { allowHalfOpen: false, secureTransport: 'on' },
      },
    ]);
    await plain.close();
    await tls.close();
  });

  it('does not resolve the dial before the runtime handshake opens', async () => {
    const socket = new FakeSocket();
    installCloudflareConnect(() => socket);
    let settled = false;
    const pending = cloudflareSocketDial.connect('example.com', 443).then(value => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    socket.openedState.resolve({ remoteAddress: '203.0.113.1:443' });

    const dialed = await pending;
    expect(settled).toBe(true);
    await dialed.close();
  });

  it('preserves a pre-connect Error abort reason without opening a socket', async () => {
    const connect = vi.fn(() => new FakeSocket());
    installCloudflareConnect(connect);
    const controller = new AbortController();
    const reason = new Error('stop before connect');
    controller.abort(reason);

    await expect(cloudflareSocketDial.connect('example.com', 443, { signal: controller.signal }))
      .rejects.toBe(reason);
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ['', 443],
    ['[]', 443],
    ['example.com', 0],
    ['example.com', 65_536],
    ['example.com', 1.5],
  ] as const)('rejects malformed address %s:%s before opening a socket', async (host, port) => {
    const connect = vi.fn(() => new FakeSocket());
    installCloudflareConnect(connect);

    await expect(cloudflareSocketDial.connect(host, port)).rejects.toThrow('SocketDial');
    expect(connect).not.toHaveBeenCalled();
  });

  it('closes an in-flight dial and preserves its abort reason', async () => {
    const socket = new FakeSocket();
    socket.rejectOpenOnClose = new Error('runtime close interrupted open');
    installCloudflareConnect(() => socket);
    const controller = new AbortController();
    const reason = new Error('caller canceled');
    const pending = cloudflareSocketDial.connect('example.com', 443, { signal: controller.signal });

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(socket.closeCalls).toBe(1);
  });

  it('closes a failed handshake once and preserves the runtime failure as cause', async () => {
    const socket = new FakeSocket();
    const openedError = new Error('TLS handshake failed');
    socket.openedState.reject(openedError);
    installCloudflareConnect(() => socket);

    await expect(cloudflareSocketDial.connect('example.com', 443, { tls: true }))
      .rejects.toMatchObject({ message: 'dial example.com:443 failed', cause: openedError });
    expect(socket.closeCalls).toBe(1);
  });

  it('closes post-connect aborts and repeated caller closes through one runtime close', async () => {
    const socket = new FakeSocket();
    socket.openedState.resolve({});
    installCloudflareConnect(() => socket);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const dialed = await cloudflareSocketDial.connect('example.com', 443, { signal: controller.signal });

    controller.abort();
    await socket.closed;
    await Promise.all([dialed.close(), dialed.close()]);

    expect(socket.closeCalls).toBe(1);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('keeps caller close idempotent when the runtime reports an already-errored socket', async () => {
    const socket = new FakeSocket();
    socket.openedState.resolve({});
    socket.closeError = new Error('already closed');
    installCloudflareConnect(() => socket);
    const dialed = await cloudflareSocketDial.connect('example.com', 443);

    await expect(Promise.all([dialed.close(), dialed.close()])).resolves.toEqual([undefined, undefined]);
    expect(socket.closeCalls).toBe(1);
  });
});
