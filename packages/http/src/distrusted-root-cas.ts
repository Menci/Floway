// Root certificates we refuse to anchor a TLS chain to, regardless of what a
// runtime trust store or a dependency's bundled snapshot still says.
//
// This mirrors the root removal in Node.js ae223417 (`crypto: update root
// certificates to NSS 3.131.1`): exactly the three emSign roots that NSS
// 3.131.1 dropped. `AAA Certificate Services` is deliberately absent — NSS
// never trusted it for server authentication, but it is still the anchor for
// legitimate cross-signed hierarchies (the SSL.com root that signs
// `example.com` is one), and removing it takes those sites down.
//
// Removing these roots alone is not enough: the compromised intermediates are
// also cross-signed by roots we keep. The companion blocklist in
// `blocked-spki.ts` rejects the keys themselves.
//
// Entries are keyed by the SHA-256 of the certificate's DER encoding rather
// than by subject name, so a reissued certificate that reuses the name is not
// rejected by accident.

import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';

export interface DistrustedRootCA {
  readonly name: string;
  /** Lowercase hex SHA-256 over the DER encoding of the certificate. */
  readonly sha256: string;
  readonly reason: string;
  readonly references: readonly string[];
}

export const DISTRUSTED_ROOT_CAS: readonly DistrustedRootCA[] = [
  {
    name: 'emSign ECC Root CA - G3',
    sha256: '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
    reason: 'Signed the eight eMudhra intermediates whose private keys were recovered from their public certificates.',
    references: [
      'https://bugzilla.mozilla.org/show_bug.cgi?id=2084101',
      'https://github.com/nodejs/node/commit/ae223417d9646775f71da8b68b8e5b3204393194',
      'https://www.debian.org/security/2026/dsa-6572',
    ],
  },
  {
    name: 'emSign Root CA - C1',
    sha256: '125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f',
    reason: 'Dropped from NSS 3.131.1 together with the compromised emSign ECC Root CA - G3.',
    references: [
      'https://bugzilla.mozilla.org/show_bug.cgi?id=2083709',
      'https://github.com/nodejs/node/commit/ae223417d9646775f71da8b68b8e5b3204393194',
    ],
  },
  {
    name: 'emSign ECC Root CA - C3',
    sha256: 'bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3',
    reason: 'Dropped from NSS 3.131.1 together with the compromised emSign ECC Root CA - G3.',
    references: [
      'https://bugzilla.mozilla.org/show_bug.cgi?id=2083709',
      'https://github.com/nodejs/node/commit/ae223417d9646775f71da8b68b8e5b3204393194',
    ],
  },
];

const DISTRUSTED_SHA256 = new Set(DISTRUSTED_ROOT_CAS.map(certificate => certificate.sha256));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a certificate's DER encoding, lowercase hex without separators. */
export const certificateSha256 = (der: Uint8Array): string => toHex(sha256(der));

const pemToDer = (pem: string): Uint8Array =>
  base64.decode(pem.replace(/-----(?:BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''));

export const isDistrustedRootCA = (pem: string): boolean =>
  DISTRUSTED_SHA256.has(certificateSha256(pemToDer(pem)));

/** Drop every distrusted certificate, preserving the order of the rest. */
export const filterDistrustedRootCAs = (pems: readonly string[]): string[] =>
  pems.filter(pem => !isDistrustedRootCA(pem));
