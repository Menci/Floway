import net from 'node:net';
import tls from 'node:tls';

import { describe, expect, it } from 'vitest';

import { createTestCertificateChain, type TestCertificateChain } from './test-utils/certificates.ts';
import { startNodeTls } from '../src/tls-upgrade.ts';

// A leaf that covers every identity the tests dial.
const makeChain = async (): Promise<TestCertificateChain> => await createTestCertificateChain({
  dnsNames: ['localhost', 'api.example.test'],
  ipAddresses: ['127.0.0.1'],
});

// `startNodeTls` consults the runtime's trust store, so a test that expects a
// successful handshake installs its CA there for the duration.
const withTrustedCa = async (ca: string, run: () => Promise<void>): Promise<void> => {
  const original = tls.getCACertificates('default');
  tls.setDefaultCACertificates([...original, ca]);
  try {
    await run();
  } finally {
    tls.setDefaultCACertificates(original);
  }
};

const startTlsServer = async (
  chain: TestCertificateChain,
  onData: (socket: tls.TLSSocket, chunk: Buffer) => void = () => {},
): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = tls.createServer({ cert: chain.leaf, key: chain.key, ca: chain.ca }, socket => {
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

const expectEcho = async (secure: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<void> => {
  const writer = secure.writable.getWriter();
  await writer.write(new TextEncoder().encode('ping'));
  writer.releaseLock();

  const reader = secure.readable.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe('ping');
  reader.releaseLock();
  await secure.readable.cancel();
};

describe('startNodeTls — handshake', () => {
  it('completes a handshake and carries application data both ways', async () => {
    const chain = await makeChain();
    await withTrustedCa(chain.ca, async () => {
      const server = await startTlsServer(chain, (socket, chunk) => socket.write(chunk));
      try {
        await expectEcho(await startNodeTls(await dialRaw(server.port), { host: 'localhost' }));
      } finally {
        await server.close();
      }
    });
  });

  it('verifies the leaf against verifyHost rather than the SNI name', async () => {
    const chain = await makeChain();
    await withTrustedCa(chain.ca, async () => {
      const server = await startTlsServer(chain);
      try {
        // SNI goes out as the dialed name; the certificate is proven for a
        // different identity in the same SAN set.
        const secure = await startNodeTls(await dialRaw(server.port), {
          host: 'localhost',
          verifyHost: 'api.example.test',
        });
        await secure.readable.cancel();
      } finally {
        await server.close();
      }
    });
  });

  it('rejects a reference identity the certificate does not cover', async () => {
    const chain = await makeChain();
    await withTrustedCa(chain.ca, async () => {
      const server = await startTlsServer(chain);
      try {
        await expect(startNodeTls(await dialRaw(server.port), {
          host: 'localhost',
          verifyHost: 'other.example.test',
        })).rejects.toThrow(/not in the cert's altnames|does not match/i);
      } finally {
        await server.close();
      }
    });
  });

  it('accepts an untrusted certificate when insecure is set', async () => {
    const chain = await makeChain();
    const server = await startTlsServer(chain, (socket, chunk) => socket.write(chunk));
    try {
      await expectEcho(await startNodeTls(await dialRaw(server.port), {
        host: 'other.example.test',
        insecure: true,
      }));
    } finally {
      await server.close();
    }
  });
});

describe('startNodeTls — prefix and lifecycle', () => {
  it('writes the prefix ahead of the ClientHello on the plaintext transport', async () => {
    const chain = await makeChain();
    await withTrustedCa(chain.ca, async () => {
      // The tap is a plain TCP listener, so it sees exactly what the upgrade
      // emits before the handshake begins.
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
      expect(received[13]).toBe(0x16);
    });
  });

  it('rejects an already-aborted signal without starting a handshake', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = { readable: new ReadableStream<Uint8Array>(), writable: new WritableStream<Uint8Array>() };

    await expect(startNodeTls(transport, { host: 'localhost', signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('tears the peer connection down when the caller aborts after the handshake', async () => {
    const chain = await makeChain();
    await withTrustedCa(chain.ca, async () => {
      let peerClosedResolve!: () => void;
      const peerClosed = new Promise<void>(resolve => { peerClosedResolve = resolve; });
      const server = tls.createServer({ cert: chain.leaf, key: chain.key, ca: chain.ca }, socket => {
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
});
