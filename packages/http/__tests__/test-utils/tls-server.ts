// Local TLS server for userspace-TLS handshake tests.
//
// A real handshake is the only way to observe what the library hands a
// caller-supplied `checkServerIdentity`. The certificate is generated per run
// so no private key is ever checked in.
import { webcrypto } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from '@peculiar/x509';

import type { DuplexStream } from '../../src/types.ts';

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const VALIDITY_MS = 24 * 60 * 60 * 1000;

const toPem = (label: string, der: ArrayBuffer): string => {
  const base64 = Buffer.from(der).toString('base64').match(/.{1,64}/g)!;
  return `-----BEGIN ${label}-----\n${base64.join('\n')}\n-----END ${label}-----\n`;
};

export interface FixtureTlsServer {
  port: number;
  close: () => Promise<void>;
}

export const startFixtureTlsServer = async (): Promise<FixtureTlsServer> => {
  const keys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=unrelated.example',
    notBefore: new Date(Date.now() - VALIDITY_MS),
    notAfter: new Date(Date.now() + VALIDITY_MS),
    signingAlgorithm: ALGORITHM,
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'dns', value: 'api.example.test' },
        { type: 'ip', value: '127.0.0.1' },
      ]),
    ],
  });
  const cert = certificate.toString('pem');
  const key = toPem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));

  const server = tls.createServer({ cert, key }, socket => {
    socket.on('data', chunk => socket.write(chunk));
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

export const connectRaw = async (port: number): Promise<DuplexStream> => {
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
