import { EventEmitter } from 'node:events';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { socketToWritable } from '../src/node-socket-streams.ts';
import { nodeSocketDial } from '../src/socket-dial.ts';
import { UpstreamTransportError } from '@floway-dev/http';

it.each([true, false])('classifies a Node socket write failure when the write confirms a network error=%s', async network => {
  const failure = network
    ? Object.assign(new Error('socket reset'), { code: 'ECONNRESET', syscall: 'write', errno: -54 })
    : new TypeError('bad adapter state');
  const socket = Object.assign(new EventEmitter(), {
    write: (_chunk: Uint8Array, callback: (error: Error) => void) => callback(failure),
  }) as net.Socket;
  const writer = socketToWritable(socket).getWriter();
  const result = await writer.write(new Uint8Array([5])).catch((error: unknown) => error);
  if (network) {
    expect(result).toBeInstanceOf(UpstreamTransportError);
    expect(result).toMatchObject({ cause: failure });
  } else {
    expect(result).toBe(failure);
  }
  writer.releaseLock();
});

// Loopback echo server lets us verify that DialedSocket teardown actually
// reaches the underlying net.Socket — Writable.toWeb / Readable.toWeb
// behaviour around abort/cancel is non-obvious and the rest of the proxy
// library assumes a cancelled stream destroys its FD.
const startEchoServer = async (): Promise<{ port: number; close: () => Promise<void>; lastSocket: () => net.Socket | null }> => {
  let lastSocket: net.Socket | null = null;
  const server = net.createServer(socket => {
    lastSocket = socket;
    socket.on('data', chunk => socket.write(chunk));
    socket.on('error', () => { /* peer hangup is expected during teardown */ });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('echo server has no address');
  return {
    port: address.port,
    close: () => new Promise(resolve => server.close(() => resolve())),
    lastSocket: () => lastSocket,
  };
};

const withDeadline = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_000);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

describe('nodeSocketDial', () => {
  let server: Awaited<ReturnType<typeof startEchoServer>>;
  beforeEach(async () => { server = await startEchoServer(); });
  afterEach(async () => { await server.close(); });

  it('ends the readable on peer FIN while leaving the writable half open', async () => {
    let receivedAfterFinResolve!: () => void;
    const receivedAfterFin = new Promise<void>(resolve => { receivedAfterFinResolve = resolve; });
    const halfCloseServer = net.createServer({ allowHalfOpen: true }, socket => {
      let received = '';
      socket.on('data', chunk => {
        received += chunk.toString();
        if (received === 'still-open') receivedAfterFinResolve();
      });
      socket.end('bye');
    });
    await new Promise<void>(resolve => halfCloseServer.listen(0, '127.0.0.1', resolve));
    const address = halfCloseServer.address();
    if (!address || typeof address === 'string') throw new Error('half-close server has no address');

    const dialed = await nodeSocketDial.connect('127.0.0.1', address.port);
    try {
      // Adapted from workerd's allowHalfOpen=true contract test: read through
      // peer EOF, then prove the same connection's writable side remains open.
      // https://github.com/cloudflare/workerd/blob/243fd41f8944c2446c46e415373b107ecb9bc789/src/workerd/api/tests/outbound-interceptor-socket-test.js#L169-L183
      await expect(withDeadline(new Response(dialed.readable).text(), 'peer FIN')).resolves.toBe('bye');

      const writer = dialed.writable.getWriter();
      await writer.write(new TextEncoder().encode('still-open'));
      writer.releaseLock();
      await withDeadline(receivedAfterFin, 'data written after peer FIN');
    } finally {
      await dialed.close();
      await new Promise<void>(resolve => halfCloseServer.close(() => resolve()));
    }
  });

  it('destroys the socket when the readable is canceled', async () => {
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port);
    try {
      const writer = dialed.writable.getWriter();
      await writer.write(new TextEncoder().encode('warmup'));
      writer.releaseLock();
      const reader = dialed.readable.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('warmup');
      reader.releaseLock();

      const remote = server.lastSocket();
      if (!remote) throw new Error('echo server did not accept the socket');
      const remoteClosed = new Promise<void>(resolve => remote.once('close', () => resolve()));
      await dialed.readable.cancel(new Error('consumer canceled'));
      await withDeadline(remoteClosed, 'peer close after readable cancellation');
    } finally {
      await dialed.close();
    }
  });

  it('propagates the owned close reason through a pending socket read', async () => {
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port);
    const reason = new Error('owned abort');
    const reader = dialed.readable.getReader();
    const pending = reader.read().then(() => null, (cause: unknown) => cause);
    await dialed.close(reason);
    const failure = await pending;
    expect(failure).toBe(reason);
    expect(failure).not.toBeInstanceOf(UpstreamTransportError);
    reader.releaseLock();
  });

  // The proxy URL parser hands `url.hostname` straight through, which keeps
  // `[...]` around an IPv6 literal. Node's `net.connect({ host: '[::1]' })`
  // falls through to DNS and fails ENOTFOUND — the platform impl strips the
  // envelope before reaching the runtime so callers can pass the parsed
  // hostname unchanged.
  it('connects to a bracketed IPv6 loopback literal by stripping the envelope', async () => {
    const v6Server = net.createServer(socket => {
      socket.on('data', chunk => socket.write(chunk));
      socket.on('error', () => { /* peer hangup is expected during teardown */ });
    });
    await new Promise<void>(resolve => v6Server.listen(0, '::1', () => resolve()));
    const address = v6Server.address();
    if (!address || typeof address === 'string') throw new Error('v6 server has no address');
    try {
      const dialed = await nodeSocketDial.connect('[::1]', address.port);
      const writer = dialed.writable.getWriter();
      await writer.write(new TextEncoder().encode('hi'));
      writer.releaseLock();
      const reader = dialed.readable.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('hi');
      reader.releaseLock();
      await dialed.close();
    } finally {
      await new Promise<void>(resolve => v6Server.close(() => resolve()));
    }
  });
});
