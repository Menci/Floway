import { readFile } from 'node:fs/promises';

import * as reclaimTls from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';
import { describe, expect, it } from 'vitest';

import { connectRaw, startFixtureTlsServer } from './test-utils/tls-server.ts';
import { makeFakeDuplex } from './test-utils.ts';
import { userspaceTls } from '../src/tls.ts';

const { loadX509FromPem, setCryptoImplementation, verifyCertificateChain } = reclaimTls;

const startObservedHandshake = (
  host: string,
): {
  fake: ReturnType<typeof makeFakeDuplex>;
  abort: AbortController;
  handshake: ReturnType<typeof userspaceTls>;
} => {
  const fake = makeFakeDuplex();
  const abort = new AbortController();
  const handshake = userspaceTls(
    { readable: fake.readable, writable: fake.writable },
    { host, signal: abort.signal },
  );
  handshake.catch(() => { /* expected when the observation aborts */ });
  return { fake, abort, handshake };
};

const waitForClientHello = async (
  fake: ReturnType<typeof makeFakeDuplex>,
): Promise<Uint8Array> => {
  const deadline = Date.now() + 1000;
  while (fake.written().byteLength < 200 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5));
  }
  return fake.written();
};

const clientHelloServerName = (record: Uint8Array): string | undefined => {
  let offset = 5;
  if (record[offset++] !== 0x01) throw new Error('expected ClientHello');
  offset += 3; // handshake length
  offset += 2 + 32; // legacy version + random
  const sessionIdLength = record[offset++]!;
  offset += sessionIdLength;
  const cipherSuitesLength = (record[offset]! << 8) | record[offset + 1]!;
  offset += 2 + cipherSuitesLength;
  const compressionMethodsLength = record[offset++]!;
  offset += compressionMethodsLength;
  const extensionsLength = (record[offset]! << 8) | record[offset + 1]!;
  offset += 2;
  const extensionsEnd = offset + extensionsLength;

  while (offset < extensionsEnd) {
    const type = (record[offset]! << 8) | record[offset + 1]!;
    const length = (record[offset + 2]! << 8) | record[offset + 3]!;
    offset += 4;
    if (type === 0) {
      const nameListLength = (record[offset]! << 8) | record[offset + 1]!;
      let nameOffset = offset + 2;
      const nameListEnd = nameOffset + nameListLength;
      while (nameOffset < nameListEnd) {
        const nameType = record[nameOffset++]!;
        const nameLength = (record[nameOffset]! << 8) | record[nameOffset + 1]!;
        nameOffset += 2;
        if (nameType === 0) {
          return new TextDecoder().decode(record.slice(nameOffset, nameOffset + nameLength));
        }
        nameOffset += nameLength;
      }
      return undefined;
    }
    offset += length;
  }
  return undefined;
};

describe('userspaceTls — input validation', () => {
  it('rejects synchronously when the supplied AbortSignal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new DOMException('client gone', 'AbortError'));
    const fake = makeFakeDuplex();
    await expect(
      userspaceTls(
        { readable: fake.readable, writable: fake.writable },
        { host: 'example.com', signal: ac.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError', message: expect.stringContaining('client gone') });
  });
});

describe('userspaceTls — handshake failure', () => {
  it('rejects with an AbortError when the signal aborts AFTER the ClientHello but before the ServerHello', async () => {
    const fake = makeFakeDuplex();
    const ac = new AbortController();
    const promise = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host: 'example.com', signal: ac.signal },
    );
    // Let the ClientHello be emitted first.
    await new Promise(r => setTimeout(r, 10));
    expect(fake.written().byteLength).toBeGreaterThan(0);
    ac.abort(new DOMException('cancel after ClientHello', 'AbortError'));
    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
      message: expect.stringContaining('cancel after ClientHello'),
    });
  });

  it('wraps a non-Error abort reason as DOMException(AbortError) on the rejection', async () => {
    // signalAbortReason normalises a primitive reason (string/number/null)
    // into a DOMException so every consumer sees an Error-shaped rejection
    // and stack traces survive. The reason's string form rides through as
    // the message.
    const fake = makeFakeDuplex();
    const ac = new AbortController();
    const promise = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host: 'example.com', signal: ac.signal },
    );
    setTimeout(() => ac.abort('plain string reason'), 5);
    await expect(promise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'plain string reason',
    });
  });
});

describe('userspaceTls — prefix coalescing', () => {
  it('emits the prefix bytes ahead of the ClientHello in the same first write', async () => {
    const fake = makeFakeDuplex();
    const ac = new AbortController();
    const handshake = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      {
        host: 'example.com',
        signal: ac.signal,
        prefix: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      },
    );
    handshake.catch(() => { /* expected — we abort below */ });

    const written = await waitForClientHello(fake);
    expect(written[0]).toBe(0xde);
    expect(written[1]).toBe(0xad);
    expect(written[2]).toBe(0xbe);
    expect(written[3]).toBe(0xef);
    // Index 4 is the start of the TLS record (type=Handshake).
    expect(written[4]).toBe(0x16);

    ac.abort(new DOMException('done', 'AbortError'));
    await handshake.catch(() => { /* expected */ });
  });

  it('includes SNI for a DNS hostname', async () => {
    const host = 'sni-test.example';
    const { fake, abort, handshake } = startObservedHandshake(host);

    expect(clientHelloServerName(await waitForClientHello(fake))).toBe(host);

    abort.abort(new DOMException('done', 'AbortError'));
    await handshake.catch(() => { /* expected */ });
  });

  it.each(['192.0.2.10', '2001:db8::1'])(
    'omits SNI for the IP literal %s',
    async host => {
      const { fake, abort, handshake } = startObservedHandshake(host);

      expect(clientHelloServerName(await waitForClientHello(fake))).toBeUndefined();

      abort.abort(new DOMException('done', 'AbortError'));
      await handshake.catch(() => { /* expected */ });
    },
  );

  it.each([
    '',
    '192.0.2.256',
    '0xC0.0.2.10',
    '192.0.2.10:443',
    '2001:db8::1::1',
    '2001:db8::1%eth0',
    '[2001:db8::1]',
  ])('rejects invalid identity %j before writing a ClientHello', async host => {
    const fake = makeFakeDuplex();

    await expect(userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host },
    )).rejects.toThrow(`Invalid TLS host identity ${host}`);
    expect(fake.written()).toHaveLength(0);
  });
});

const quietLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() { return quietLogger; },
};

const loadFixtureCertificate = async (name: string) =>
  loadX509FromPem(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const verifyFixtureCertificate = async (
  certificate: Parameters<typeof verifyCertificateChain>[0][number],
  host: string,
): Promise<void> => {
  setCryptoImplementation(webcryptoCrypto);
  await verifyCertificateChain(
    [certificate],
    host,
    quietLogger,
    undefined,
    [certificate],
  );
};

const verifyFixtureIdentity = async (fixture: string, host: string): Promise<void> => {
  await verifyFixtureCertificate(await loadFixtureCertificate(fixture), host);
};

describe('userspaceTls — certificate reference identity', () => {
  it('rejects a mismatched IPv4 iPAddress SAN', async () => {
    await expect(verifyFixtureIdentity('ip-san.generated.pem', '192.0.2.11'))
      .rejects.toThrow('Certificate is not for host 192.0.2.11');
  });

  it('matches equivalent IPv6 text forms by address bytes', async () => {
    await expect(
      verifyFixtureIdentity('ip-san.generated.pem', '2001:0db8:0:0:0:0:0:1'),
    ).resolves.toBeUndefined();
  });

  it('does not treat an IP-valued CN or DNS SAN as an IP identity', async () => {
    await expect(verifyFixtureIdentity('ip-cn-dns-san.generated.pem', '192.0.2.10'))
      .rejects.toThrow('Certificate is not for host 192.0.2.10');
  });

  it('fails closed when a custom certificate adapter cannot expose IP SANs', async () => {
    const certificate = await loadFixtureCertificate('ip-san.generated.pem');
    const { getAlternativeIPAddresses: _, ...adapterWithoutIpSans } = certificate;

    await expect(verifyFixtureCertificate(adapterWithoutIpSans, '192.0.2.10'))
      .rejects.toThrow('Certificate is not for host 192.0.2.10');
  });

  it.each(['[2001:db8::1]', '2001:db8::1%eth0', '192.00.2.10'])(
    'rejects invalid certificate reference identity %s',
    async host => {
      await expect(verifyFixtureIdentity('ip-san.generated.pem', host))
        .rejects.toThrow(`Invalid TLS host identity ${host}`);
    },
  );

  it('preserves DNS SAN wildcard matching for DNS hosts', async () => {
    await expect(verifyFixtureIdentity('ip-san.generated.pem', 'api.example.test')).resolves.toBeUndefined();
  });
});

describe('userspaceTls — checkServerIdentity', () => {
  // The fixture's leaf chains to no root the library ships. A case that
  // expects the callback's error therefore also proves the ordering: the
  // callback runs before chain validation, which would otherwise reject first.
  it('receives verifyHost and the presented leaf, and can reject', async () => {
    const seen: Array<{ identity: string; cn: unknown; san: string | undefined }> = [];
    const chain = await startFixtureTlsServer();
    try {
      await expect(userspaceTls(await connectRaw(chain.port), {
        host: 'localhost',
        verifyHost: 'api.example.test',
        checkServerIdentity: (identity, certificate) => {
          seen.push({ identity, cn: certificate.subject.CN, san: certificate.subjectaltname });
          return new Error('stop after observing');
        },
      })).rejects.toThrow(/stop after observing/);
    } finally {
      await chain.close();
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.identity).toBe('api.example.test');
    expect(seen[0]!.san).toContain('DNS:localhost');
    expect(seen[0]!.san).toContain('DNS:api.example.test');
  });

  it('still enforces chain trust when the callback accepts', async () => {
    const chain = await startFixtureTlsServer();
    try {
      await expect(userspaceTls(await connectRaw(chain.port), {
        host: 'localhost',
        verifyHost: 'not-in-the-certificate.example',
        checkServerIdentity: () => undefined,
      })).rejects.toThrow(/does not chain to a trusted root|Missing issuer/);
    } finally {
      await chain.close();
    }
  });

  it('cannot be bypassed by insecure', async () => {
    const chain = await startFixtureTlsServer();
    let calls = 0;
    try {
      const secure = await userspaceTls(await connectRaw(chain.port), {
        host: 'localhost',
        insecure: true,
        checkServerIdentity: () => { calls++; return undefined; },
      });
      await secure.readable.cancel();
    } finally {
      await chain.close();
    }
    expect(calls).toBe(0);
  });
});
