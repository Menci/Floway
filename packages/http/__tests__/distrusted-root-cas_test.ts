import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { MOZILLA_ROOT_CA_LIST } from '@reclaimprotocol/tls';
import { describe, expect, it } from 'vitest';

import {
  DISTRUSTED_ROOT_CAS,
  certificateSha256,
  filterDistrustedRootCAs,
  isDistrustedRootCA,
} from '../src/distrusted-root-cas.ts';

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const pemToDer = (pem: string): Uint8Array =>
  new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'));

describe('distrusted root certificates', () => {
  it('matches the roots Node.js dropped in NSS 3.131.1', () => {
    expect(DISTRUSTED_ROOT_CAS.map(root => root.name)).toEqual([
      'emSign ECC Root CA - G3',
      'emSign Root CA - C1',
      'emSign ECC Root CA - C3',
    ]);
  });

  it('recognises emSign ECC Root CA - G3 by its DER digest', async () => {
    const pem = await fixture('em-sign-ecc-root-ca-g3.generated.pem');
    const entry = DISTRUSTED_ROOT_CAS.find(root => root.name === 'emSign ECC Root CA - G3')!;

    expect(certificateSha256(pemToDer(pem))).toBe(entry.sha256);
    expect(isDistrustedRootCA(pem)).toBe(true);
  });

  // NSS never trusted AAA for server authentication, but it still anchors
  // legitimate cross-signed hierarchies — `example.com` reaches its SSL.com
  // root through one. Dropping it would take those sites down.
  it('keeps AAA Certificate Services trusted', async () => {
    const pem = await fixture('aaa-certificate-services.generated.pem');

    expect(isDistrustedRootCA(pem)).toBe(false);
  });

  it('records a reason and at least one primary source for every entry', () => {
    for (const root of DISTRUSTED_ROOT_CAS) {
      expect(root.reason.length).toBeGreaterThan(0);
      expect(root.references.length).toBeGreaterThan(0);
      expect(root.references.every(reference => reference.startsWith('https://'))).toBe(true);
    }
  });

  it('keeps certificates that are not on the list, preserving order', async () => {
    const trusted = await fixture('ip-san.generated.pem');
    const distrusted = await fixture('em-sign-ecc-root-ca-g3.generated.pem');

    expect(filterDistrustedRootCAs([trusted, distrusted, trusted])).toEqual([trusted, trusted]);
  });
});

// The library bundles its own Mozilla snapshot, so filtering what the runtime
// contributes says nothing about the list the client actually anchors to. The
// patch removes the roots there; this fails if the patch stops applying.
describe('bundled Mozilla snapshot', () => {
  it('carries none of the distrusted roots', () => {
    expect(MOZILLA_ROOT_CA_LIST.filter(pem => isDistrustedRootCA(pem))).toEqual([]);
  });

  it('still shares roots that only cross-signed a compromised intermediate', () => {
    const names = MOZILLA_ROOT_CA_LIST.map(pem => new X509Certificate(pem).subject);

    expect(names.some(name => name.includes('AAA Certificate Services'))).toBe(true);
  });
});
