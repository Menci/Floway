import net from 'node:net';
import { runInNewContext } from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nodeSocketDial } from '../src/socket-dial.ts';

const readExactly = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  length: number,
): Promise<{ body: Uint8Array; chunks: readonly Uint8Array[] }> => {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < length) {
    const next = await reader.read();
    if (next.done) throw new Error(`socket ended after ${total} of ${length} expected bytes`);
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  if (total !== length) throw new Error(`socket returned ${total} bytes while reading an exact ${length}-byte frame`);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body, chunks };
};

// Loopback echo server lets us verify that DialedSocket teardown actually
// reaches the underlying net.Socket — Writable.toWeb / Readable.toWeb
// behaviour around abort/cancel is non-obvious and the rest of the proxy
// library assumes a cancelled stream destroys its FD.
const startEchoServer = async (): Promise<{
  port: number;
  close: () => Promise<void>;
  connectionCount: () => number;
  socketAt: (index: number) => Promise<net.Socket>;
}> => {
  const sockets: net.Socket[] = [];
  const waiters = new Map<number, (socket: net.Socket) => void>();
  const server = net.createServer(socket => {
    const index = sockets.length;
    sockets.push(socket);
    waiters.get(index)?.(socket);
    waiters.delete(index);
    socket.on('data', chunk => socket.write(chunk));
    socket.on('error', () => { /* peer hangup is expected during teardown */ });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('echo server has no address');
  return {
    port: address.port,
    close: () => new Promise(resolve => server.close(() => resolve())),
    connectionCount: () => sockets.length,
    socketAt: index => {
      const socket = sockets[index];
      return socket
        ? Promise.resolve(socket)
        : new Promise(resolve => { waiters.set(index, resolve); });
    },
  };
};

describe('nodeSocketDial', () => {
  let server: Awaited<ReturnType<typeof startEchoServer>>;
  beforeAll(async () => { server = await startEchoServer(); });
  afterAll(async () => { await server.close(); });

  it('connects, keeps retained read chunks stable, and tears down via close()', async () => {
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port);
    const writer = dialed.writable.getWriter();
    const reader = dialed.readable.getReader();
    try {
      const firstPayload = new TextEncoder().encode('retained');
      await writer.write(firstPayload);
      const first = await readExactly(reader, firstPayload.byteLength);
      expect(first.body).toEqual(firstPayload);
      const retained = first.chunks[0];
      if (retained === undefined) throw new Error('socket returned no retained chunk');
      const snapshot = retained.slice();

      for (let i = 0; i < 4; i += 1) {
        const payload = new Uint8Array(64).fill(i);
        await writer.write(payload);
        expect((await readExactly(reader, payload.byteLength)).body).toEqual(payload);
      }
      expect(retained).toEqual(snapshot);
    } finally {
      writer.releaseLock();
      reader.releaseLock();
      await dialed.close();
    }
  });

  it.each(['', '[]'])('rejects empty dial host %j without opening a socket', async host => {
    const connectionsBefore = server.connectionCount();
    await expect(nodeSocketDial.connect(host, server.port)).rejects.toThrow('SocketDial host must not be empty');
    expect(server.connectionCount()).toBe(connectionsBefore);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 65_536])(
    'rejects invalid dial port %s without opening a socket',
    async port => {
      const connectionsBefore = server.connectionCount();
      await expect(nodeSocketDial.connect('127.0.0.1', port))
        .rejects.toThrow('SocketDial port must be an integer between 1 and 65535');
      expect(server.connectionCount()).toBe(connectionsBefore);
    },
  );

  it('does not send an invalid TLS SNI extension for an IP address', async () => {
    const rejectingServer = net.createServer(socket => socket.destroy());
    await new Promise<void>(resolve => rejectingServer.listen(0, '127.0.0.1', () => resolve()));
    const address = rejectingServer.address();
    if (!address || typeof address === 'string') throw new Error('TLS test server has no address');
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      if ((warning as Error & { code?: string }).code === 'DEP0123') warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      await expect(nodeSocketDial.connect('127.0.0.1', address.port, { tls: true })).rejects.toThrow();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(warnings).toEqual([]);
    } finally {
      process.off('warning', onWarning);
      await new Promise<void>(resolve => rejectingServer.close(() => resolve()));
    }
  });

  it('rejects a connect against a closed port', async () => {
    // Free port: open a listener, capture its port, close immediately.
    const probe = net.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
    const addr = probe.address();
    if (!addr || typeof addr === 'string') throw new Error('probe missing address');
    const closedPort = addr.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));

    await expect(nodeSocketDial.connect('127.0.0.1', closedPort)).rejects.toThrow();
  });

  it('honours an already-aborted signal without opening a socket', async () => {
    const connectionsBefore = server.connectionCount();
    const ac = new AbortController();
    ac.abort();
    await expect(nodeSocketDial.connect('127.0.0.1', server.port, { signal: ac.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(server.connectionCount()).toBe(connectionsBefore);
  });

  it('preserves a cross-realm Error abort reason', async () => {
    const connectionsBefore = server.connectionCount();
    const reason: unknown = runInNewContext('new Error("foreign abort")');
    const ac = new AbortController();
    ac.abort(reason);

    await expect(nodeSocketDial.connect('127.0.0.1', server.port, { signal: ac.signal }))
      .rejects.toBe(reason);
    expect(server.connectionCount()).toBe(connectionsBefore);
  });

  it('destroys the underlying socket when the caller aborts post-connect', async () => {
    const ac = new AbortController();
    const accepted = server.socketAt(server.connectionCount());
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port, { signal: ac.signal });
    // Drive a single round-trip so the server-side socket is established.
    const writer = dialed.writable.getWriter();
    await writer.write(new TextEncoder().encode('warmup'));
    writer.releaseLock();
    const reader = dialed.readable.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('warmup');
    reader.releaseLock();

    const remote = await accepted;
    const remoteClosed = new Promise<void>(resolve => remote.once('close', () => resolve()));

    ac.abort();
    await remoteClosed;

    expect(remote.destroyed).toBe(true);
    await dialed.close();
  });

  it('writer.abort destroys both socket halves with no fixed-delay teardown', async () => {
    const accepted = server.socketAt(server.connectionCount());
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port);
    const remote = await accepted;
    const remoteClosed = new Promise<void>(resolve => remote.once('close', () => resolve()));
    const writer = dialed.writable.getWriter();

    await writer.abort(new Error('stop writing'));
    await remoteClosed;
    writer.releaseLock();

    expect(remote.destroyed).toBe(true);
    await dialed.close();
  });

  it('writer.close half-closes plain TCP while the readable side remains usable', async () => {
    let peer: net.Socket | undefined;
    let acceptRemote!: (socket: net.Socket) => void;
    const accepted = new Promise<net.Socket>(resolve => { acceptRemote = resolve; });
    const halfOpenServer = net.createServer({ allowHalfOpen: true }, socket => {
      acceptRemote(socket);
      socket.on('error', () => { /* peer teardown is expected */ });
    });
    await new Promise<void>(resolve => halfOpenServer.listen(0, '127.0.0.1', () => resolve()));
    const address = halfOpenServer.address();
    if (!address || typeof address === 'string') throw new Error('half-open server has no address');

    try {
      const dialed = await nodeSocketDial.connect('127.0.0.1', address.port);
      peer = await accepted;
      const remoteEnded = new Promise<void>(resolve => peer.once('end', () => resolve()));
      const writer = dialed.writable.getWriter();

      await writer.close();
      await remoteEnded;
      writer.releaseLock();
      expect(peer.readableEnded).toBe(true);

      peer.write(new TextEncoder().encode('after-half-close'));
      const reader = dialed.readable.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('after-half-close');
      reader.releaseLock();
      await dialed.close();
    } finally {
      peer?.destroy();
      await new Promise<void>(resolve => halfOpenServer.close(() => resolve()));
    }
  });

  it('reader.cancel destroys the underlying socket', async () => {
    const accepted = server.socketAt(server.connectionCount());
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port);
    const remote = await accepted;
    const remoteClosed = new Promise<void>(resolve => remote.once('close', () => resolve()));
    const reader = dialed.readable.getReader();

    await reader.cancel('subscriber done');
    await remoteClosed;
    reader.releaseLock();

    expect(remote.destroyed).toBe(true);
    await dialed.close();
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
