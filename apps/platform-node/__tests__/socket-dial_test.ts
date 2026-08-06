import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeSocketDial } from '../src/socket-dial.ts';

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

  it('connects, writes, reads back, and tears down via close()', async () => {
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port);
    const writer = dialed.writable.getWriter();
    await writer.write(new TextEncoder().encode('hi'));
    writer.releaseLock();
    const reader = dialed.readable.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe('hi');
    reader.releaseLock();
    await dialed.close();
  });

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
    const ac = new AbortController();
    ac.abort();
    await expect(nodeSocketDial.connect('127.0.0.1', server.port, { signal: ac.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('destroys the underlying socket when the caller aborts post-connect', async () => {
    const ac = new AbortController();
    const dialed = await nodeSocketDial.connect('127.0.0.1', server.port, { signal: ac.signal });
    // Drive a single round-trip so the server-side socket is established.
    const writer = dialed.writable.getWriter();
    await writer.write(new TextEncoder().encode('warmup'));
    writer.releaseLock();

    ac.abort();
    // Give the abort listener a tick to call socket.destroy().
    await new Promise(r => setTimeout(r, 20));

    const remote = server.lastSocket();
    // Either reading proves the abort reached the underlying fd:
    // socket.destroy() flips `destroyed` immediately on the local side, but
    // a peer-driven FIN can leave the local socket as
    // `destroyed: false, readableEnded: true` for a tick before the close
    // event lands.
    expect(remote?.destroyed === true || remote?.readableEnded === true).toBe(true);
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
