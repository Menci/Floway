// Runtime certificate material for tests that need a real TLS handshake.
//
// A usable TLS server needs a private key, and a private key does not belong
// in the repository — not even one that is only trusted by a test. Generating
// the chain per run keeps the fixtures out of version control and lets each
// test shape the SAN set it needs.
import { webcrypto } from 'node:crypto';

import {
  BasicConstraintsExtension,
  ExtendedKeyUsage,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from '@peculiar/x509';

// ECDSA P-256 keeps generation fast enough to run per test file.
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;

const PEM_WIDTH = 64;
const toPem = (label: string, der: ArrayBuffer): string => {
  const base64 = Buffer.from(der).toString('base64').match(new RegExp(`.{1,${PEM_WIDTH}}`, 'g'))!;
  return `-----BEGIN ${label}-----\n${base64.join('\n')}\n-----END ${label}-----\n`;
};

const VALIDITY = 24 * 60 * 60 * 1000;
const notBefore = (): Date => new Date(Date.now() - VALIDITY);
const notAfter = (): Date => new Date(Date.now() + VALIDITY);

export interface TestCertificateChain {
  /** PEM of the issuing CA, for `ca` and for `tls.setDefaultCACertificates`. */
  ca: string;
  /** PEM of the leaf the server presents. */
  leaf: string;
  /** PKCS#8 PEM of the leaf's private key. */
  key: string;
}

export interface TestCertificateOptions {
  /** DNS names to place in the SAN extension. */
  dnsNames?: readonly string[];
  /** IP literals to place in the SAN extension, IPv4 or IPv6. */
  ipAddresses?: readonly string[];
}

/**
 * Issue a leaf under a freshly generated CA. The leaf's subject names an
 * unrelated host, so a test that passes proves the SANs were read.
 */
export const createTestCertificateChain = async (
  options: TestCertificateOptions = {},
): Promise<TestCertificateChain> => {
  const caKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const ca = await X509CertificateGenerator.createSelfSigned({
    serialNumber: '01',
    name: 'CN=Floway test CA',
    notBefore: notBefore(),
    notAfter: notAfter(),
    signingAlgorithm: ALGORITHM,
    keys: caKeys,
    extensions: [
      new BasicConstraintsExtension(true, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign),
    ],
  });

  const leafKeys = await webcrypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const leaf = await X509CertificateGenerator.create({
    serialNumber: '02',
    subject: 'CN=unrelated.example',
    issuer: ca.subject,
    notBefore: notBefore(),
    notAfter: notAfter(),
    signingAlgorithm: ALGORITHM,
    publicKey: leafKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature),
      new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
      new SubjectAlternativeNameExtension([
        ...(options.dnsNames ?? []).map(value => ({ type: 'dns' as const, value })),
        ...(options.ipAddresses ?? []).map(value => ({ type: 'ip' as const, value })),
      ]),
    ],
  });

  return {
    ca: ca.toString('pem'),
    leaf: leaf.toString('pem'),
    key: toPem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', leafKeys.privateKey)),
  };
};
