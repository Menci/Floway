import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { isBlockedSPKI } from '@reclaimprotocol/tls';
import { describe, expect, it } from 'vitest';

import {
  BLOCKED_SPKIS,
  installBlockedSpkiCheck,
  spkiSha256,
} from '../src/blocked-spki.ts';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const spkiOf = (pem: string): Uint8Array =>
  new Uint8Array(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }));

describe('blocked SubjectPublicKeyInfo list', () => {
  it('blocks the eight eMudhra intermediates Node.js and Go block', () => {
    expect(BLOCKED_SPKIS).toHaveLength(8);
    expect(new Set(BLOCKED_SPKIS.map(spki => spki.sha256)).size).toBe(8);
  });

  it('matches the digest openssl reports for the live intermediate', async () => {
    // Captured from dv-g3b-emudhra.we-have-a-problem.com, one of the hosts
    // publishing a chain through the compromised key.
    const pem = await fixture('em-dv-tls-ca-g3b.generated.pem');

    expect(spkiSha256(spkiOf(pem))).toBe('ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105');
  });
});

describe('installBlockedSpkiCheck', () => {
  // The client consults this hook for every certificate it walks, so the test
  // drives the same entry point the handshake uses rather than the digest
  // helper directly.
  it('installs a hook that rejects the compromised key', async () => {
    const compromised = await fixture('em-dv-tls-ca-g3b.generated.pem');
    const trusted = await fixture('ip-san.generated.pem');

    installBlockedSpkiCheck();

    expect(isBlockedSPKI(spkiOf(compromised))).toBe(true);
    expect(isBlockedSPKI(spkiOf(trusted))).toBe(false);
  });
});
