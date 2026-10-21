// The public keys we refuse to trust, and the hook that installs the check
// into the userspace TLS client.
//
// Removing a root is the wrong instrument for a compromised intermediate.
// The eight eMudhra intermediates were cross-signed by several roots, and
// unrelated hierarchies share those roots — `example.com` today reaches
// `SSL.com TLS ECC Root CA 2022` through a `AAA Certificate Services`
// cross-sign — so dropping a root breaks those sites while leaving the
// compromised key usable through another cross-sign. Node.js adopted the
// same instrument in nodejs/node#66871, with hashes byte-identical to Go's
// CVE-2026-111943 fix and Electron's patch.
//
// Entries are the SHA-256 of the DER-encoded SubjectPublicKeyInfo, the digest
// `i2d_X509_PUBKEY` produces.

import { sha256 } from '@noble/hashes/sha2.js';
import { setBlockedSPKIChecker } from '@reclaimprotocol/tls';

export interface BlockedSpki {
  readonly name: string;
  /** Lowercase hex SHA-256 over the DER-encoded SubjectPublicKeyInfo. */
  readonly sha256: string;
}

// On 30 April 2025 eMudhra's key-generation ceremony produced a second,
// unintended set of P-384 intermediate keys whose private scalars were below
// 256 — one is literally 4 — so anyone can recover them from the published
// certificates and sign for any name.
export const EMUDHRA_COMPROMISE = {
  reason: 'Private key recoverable from the published certificate after the 30 April 2025 ceremony produced sub-256-bit scalars.',
  references: [
    'https://blog.mozilla.org/security/2026/10/20/protecting-firefox-users-following-the-compromise-of-emudhra-intermediate-certificates/',
    'https://github.com/nodejs/node/pull/66871',
    'https://www.openwall.com/lists/oss-security/2026/10/20/30',
  ],
} as const;

export const BLOCKED_SPKIS: readonly BlockedSpki[] = [
  { name: 'EM DV TLS CA - G3B', sha256: 'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105' },
  { name: 'EM OV TLS CA - G3B', sha256: '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b' },
  { name: 'EM EV TLS CA - G3B', sha256: 'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41' },
  { name: 'EM OV CS CA - G3B', sha256: 'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6' },
  { name: 'EM DV TLS CA - G3C', sha256: '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f' },
  { name: 'EM OV TLS CA - G3C', sha256: '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8' },
  { name: 'EM EV TLS CA - G3C', sha256: '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0' },
  { name: 'EM OV CS CA - G3C', sha256: '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30' },
];

const BLOCKED_SHA256 = new Set(BLOCKED_SPKIS.map(spki => spki.sha256));

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a DER-encoded SubjectPublicKeyInfo, lowercase hex. */
export const spkiSha256 = (spki: Uint8Array): string => toHex(sha256(spki));

/**
 * Install the blocklist into the TLS client, which consults it for every
 * certificate it walks — before that certificate is allowed to anchor a
 * chain — so a compromised key is rejected no matter which root cross-signed
 * it.
 */
export const installBlockedSpkiCheck = (): void => {
  setBlockedSPKIChecker(spki => BLOCKED_SHA256.has(spkiSha256(spki)));
};
