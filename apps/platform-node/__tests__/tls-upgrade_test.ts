import { readFile } from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';

import { describe, expect, it } from 'vitest';

import { startNodeTls } from '../src/tls-upgrade.ts';

const readText = async (name: string): Promise<string> =>
  await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const startTlsServer = async (
  ca: string,
  leaf: string,
  key: string,
  onData: (socket: tls.TLSSocket, chunk: Buffer) => void = () => {},
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = tls.createServer({ cert: leaf, key, ca }, socket => {
    socket.on('data', chunk => onData(socket, chunk));
    socket.on('error', () => { /* peer hangup is expected during teardown */ });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('TLS server has no address');
  return {
    port: address.port,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
};

const dialRaw = async (port: number): Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }> => {
  const socket = net.connect({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return {
    readable: new ReadableStream<Uint8Array>({
      start(controller) {
        socket.on('data', chunk => controller.enqueue(new Uint8Array(chunk)));
        socket.on('end', () => controller.close());
        socket.on('error', error => controller.error(error));
      },
      cancel() { socket.destroy(); },
    }),
    writable: new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          socket.write(chunk, error => (error ? reject(error) : resolve()));
        });
      },
      close() { socket.end(); },
      abort(reason) { socket.destroy(reason instanceof Error ? reason : undefined); },
    }),
  };
};

// Node's default store does not contain the fixture CA, so every successful
// case installs it with `tls.setDefaultCACertificates`. `startNodeTls` has no
// CA option of its own: it trusts whatever the runtime trusts, which is the
// deployment shape these tests pin.
const withFixtureCa = (ca: string): void => {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca]);
};

const loadTlsFixtures = async (): Promise<{ ca: string; leaf: string; key: string }> => ({
  ca: await readText('floway-test-ca.generated.pem'),
  leaf: await readText('floway-test-leaf.generated.pem'),
  key: await readText('floway-test-leaf-key.generated.pem'),
});

describe('startNodeTls — handshake', () => {
  it('completes a handshake against a server whose CA is installed', async () => {
    const { ca, leaf, key } = await loadTlsFixtures();
    withFixtureCa(ca);
    const server = await startTlsServer(ca, leaf, key, (socket, chunk) => socket.write(chunk));

    try {
      const secure = await startNodeTls(await dialRaw(server.port), {
        host: 'localhost',
        verifyHost: 'localhost',
      });
      const writer = secure.writable.getWriter();
      await writer.write(new TextEncoder().encode('ping'));
      writer.releaseLock();

      const reader = secure.readable.getReader();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toBe('ping');
      reader.releaseLock();
      await secure.readable.cancel();
    } finally {
      await server.close();
    }
  });

  it('rejects a certificate whose identity differs from the requested host', async () => {
    const { ca, leaf, key } = await loadTlsFixtures();
    withFixtureCa(ca);
    const server = await startTlsServer(ca, leaf, key);

    try {
      await expect(startNodeTls(await dialRaw(server.port), {
        host: 'other.example.test',
      })).rejects.toThrow(/Certificate is not for host other\.example\.test/);
    } finally {
      await server.close();
    }
  });

  it('accepts an identity mismatch when insecure is set', async () => {
    const { ca, leaf, key } = await loadTlsFixtures();
    const server = await startTlsServer(ca, leaf, key, (socket, chunk) => socket.write(chunk));

    try {
      const secure = await startNodeTls(await dialRaw(server.port), {
        host: 'other.example.test',
        insecure: true,
      });
      const writer = secure.writable.getWriter();
      await writer.write(new TextEncoder().encode('ping'));
      writer.releaseLock();
      const reader = secure.readable.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('ping');
      reader.releaseLock();
      await secure.readable.cancel();
    } finally {
      await server.close();
    }
  });

  it('matches an IPv6 iPAddress SAN in its compressed form', async () => {
    // The fixture SAN is written `2001:DB8:0:0:0:0:0:1`. Node's built-in
    // matcher compares the SAN text and would reject the compressed form;
    // the upgrade's own check has to compare addresses.
    const { ca, leaf, key } = await loadTlsFixtures();
    withFixtureCa(ca);
    const server = await startTlsServer(ca, leaf, key);

    try {
      const secure = await startNodeTls(await dialRaw(server.port), {
        host: '2001:db8::1',
        verifyHost: '2001:db8::1',
      });
      await secure.readable.cancel();
    } finally {
      await server.close();
    }
  });
});

describe('startNodeTls — prefix and lifecycle', () => {
  it('writes the prefix before the ClientHello, on the plaintext transport', async () => {
    const { ca } = await loadTlsFixtures();
    withFixtureCa(ca);

    // Read the transport itself: a plain TCP listener sees whatever the
    // upgrade emits before it starts the handshake.
    let received = Buffer.alloc(0);
    const tap = net.createServer(socket => {
      socket.once('data', chunk => {
        received = Buffer.concat([received, chunk]);
        socket.destroy();
      });
    });
    await new Promise<void>(resolve => tap.listen(0, '127.0.0.1', resolve));
    const address = tap.address();
    if (address === null || typeof address === 'string') throw new Error('tap has no address');

    const handshake = startNodeTls(await dialRaw(address.port), {
      host: 'localhost',
      prefix: new TextEncoder().encode('TROJAN-HEADER'),
    });
    await handshake.catch(() => { /* the tap hangs up after the first write */ });
    await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise<void>(resolve => tap.close(() => resolve()));

    expect(received.subarray(0, 13).toString()).toBe('TROJAN-HEADER');
    // And the handshake record follows it, not precedes it.
    expect(received[13]).toBe(0x16);
  });

  it('rejects an already-aborted signal without opening a handshake', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = { readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>() };

    await expect(startNodeTls(transport, { host: 'localhost', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('destroys the transport when the caller aborts after the handshake', async () => {
    const { ca, leaf, key } = await loadTlsFixtures();
    withFixtureCa(ca);

    let peerClosedResolve!: () => void;
    const peerClosed = new Promise<void>(resolve => { peerClosedResolve = resolve; });
    const server = tls.createServer({ cert: leaf, key, ca }, socket => {
      socket.on('close', () => peerClosedResolve());
      socket.on('error', () => { /* expected on teardown */ });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('TLS server has no address');

    const controller = new AbortController();
    try {
      const secure = await startNodeTls(await dialRaw(address.port), {
        host: 'localhost',
        signal: controller.signal,
      });
      controller.abort();
      // The dial-time listener destroys the TLS socket, which reaches the
      // peer as a close. The readable is left errored by the same abort, so
      // cancel it without a reason to keep the teardown clean.
      await expect(Promise.race([
        peerClosed,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('peer was not torn down')), 1_000)),
      ])).resolves.toBeUndefined();
      await secure.readable.cancel().catch(() => {});
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
