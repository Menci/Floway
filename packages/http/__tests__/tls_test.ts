import { readFile } from 'node:fs/promises';

import * as reclaimTls from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';
import { describe, expect, it } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import { addTrustedRootCAs, userspaceTls } from '../src/tls.ts';

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

  it('aborts a handshake mid-flight and surfaces the abort reason', async () => {
    const fake = makeFakeDuplex();
    const ac = new AbortController();
    const promise = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host: 'example.com', signal: ac.signal },
    );
    setTimeout(() => ac.abort(new DOMException('cancelled', 'AbortError')), 30);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError', message: expect.stringContaining('cancelled') });
  });
});

describe('userspaceTls — ClientHello on the wire', () => {
  it('emits a TLS 1.0+ handshake record (0x16 0x03 0x01) as the very first bytes', async () => {
    const fake = makeFakeDuplex();
    // Handshake will never complete — the test just observes the
    // ClientHello byte shape. Detach the promise and read the wire.
    const ac = new AbortController();
    const handshake = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host: 'example.com', signal: ac.signal },
    );
    handshake.catch(() => { /* expected — we abort below */ });

    // Poll the fake duplex's write buffer until the ClientHello lands. The
    // first byte is enough to discriminate a TLS handshake record from
    // anything else; we read more once it's there. Polling avoids a hard-
    // coded sleep that races reclaim's synchronous startup path under load.
    const written = await waitForClientHello(fake);
    expect(written.byteLength).toBeGreaterThanOrEqual(5);
    // TLS record header: type=Handshake(0x16), legacy_record_version=TLS1.2(0x0303)
    // for TLS 1.3 ClientHellos (RFC 8446 §5.1).
    expect(written[0]).toBe(0x16);
    expect(written[1]).toBe(0x03);
    expect([0x01, 0x03]).toContain(written[2]); // 0x01 if reclaim emits TLS 1.0 framing, 0x03 for TLS 1.2 framing.
    // First handshake message is ClientHello (msg_type 0x01).
    expect(written[5]).toBe(0x01);

    ac.abort(new DOMException('done observing', 'AbortError'));
    await handshake.catch(() => { /* swallow expected abort */ });
  });
});

describe('userspaceTls — handshake failure', () => {
  it('rejects when the server returns junk instead of a ServerHello', async () => {
    const fake = makeFakeDuplex();
    const promise = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host: 'example.com' },
    );
    // Wait for the ClientHello to be sent.
    await new Promise(r => setTimeout(r, 5));
    // Reply with bytes that don't form a TLS record at all.
    fake.respond(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]));
    fake.endResponse();

    await expect(promise).rejects.toBeInstanceOf(Error);
  });

  it('rejects when the transport EOFs before the handshake completes', async () => {
    const fake = makeFakeDuplex();
    const promise = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host: 'example.com' },
    );
    await new Promise(r => setTimeout(r, 5));
    fake.endResponse();
    await expect(promise).rejects.toBeInstanceOf(Error);
  });

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

  it('emits a TLS record without a prefix when none is supplied', async () => {
    const fake = makeFakeDuplex();
    const ac = new AbortController();
    const handshake = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host: 'example.com', signal: ac.signal },
    );
    handshake.catch(() => { /* expected */ });

    await waitForClientHello(fake);
    expect(fake.written()[0]).toBe(0x16);

    ac.abort(new DOMException('done', 'AbortError'));
    await handshake.catch(() => { /* expected */ });
  });

  it('keeps host identity classification internal to the TLS package', () => {
    expect('classifyHostIdentity' in reclaimTls).toBe(false);
    expect('parseIpLiteral' in reclaimTls).toBe(false);
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
    '192.0.2',
    '192.0.2.10.1',
    '192..2.10',
    '192.0.2.256',
    '192.0.-1.10',
    '192.0.+2.10',
    '192.00.2.10',
    '0xC0.0.2.10',
    '0300.0.2.10',
    ' 192.0.2.10',
    '192.0.2.10 ',
    '192.0.2.10.',
    '192.0.2.10:443',
    '2001:db8::1::1',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7',
    '12345::1',
    '2001:db8::g',
    '::ffff:192.0.2.10:1',
    '::192.0.2.10:1',
    '2001:db8:192.0.2.10::',
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

interface TrustGlobals { TLS_ADDITIONAL_ROOT_CA_LIST?: string[] }

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
  it('extracts the IPv4 and IPv6 address SANs', async () => {
    const certificate = await loadFixtureCertificate('ip-san.generated.pem');
    expect(certificate.getAlternativeIPAddresses()).toEqual(['192.0.2.10', '2001:db8::1']);
  });

  it('accepts an exact IPv4 iPAddress SAN', async () => {
    await expect(verifyFixtureIdentity('ip-san.generated.pem', '192.0.2.10')).resolves.toBeUndefined();
  });

  it('rejects a mismatched IPv4 iPAddress SAN', async () => {
    await expect(verifyFixtureIdentity('ip-san.generated.pem', '192.0.2.11'))
      .rejects.toThrow('Certificate is not for host 192.0.2.11');
  });

  it('matches equivalent IPv6 text forms by address bytes', async () => {
    await expect(
      verifyFixtureIdentity('ip-san.generated.pem', '2001:0db8:0:0:0:0:0:1'),
    ).resolves.toBeUndefined();
  });

  it('rejects a different IPv6 identity', async () => {
    await expect(verifyFixtureIdentity('ip-san.generated.pem', '2001:db8::2'))
      .rejects.toThrow('Certificate is not for host 2001:db8::2');
  });

  it('does not treat an IP-valued CN or DNS SAN as an IP identity', async () => {
    await expect(verifyFixtureIdentity('ip-cn-dns-san.generated.pem', '192.0.2.10'))
      .rejects.toThrow('Certificate is not for host 192.0.2.10');
  });

  it('does not apply DNS wildcard matching to an IP identity', async () => {
    await expect(verifyFixtureIdentity('ip-san.generated.pem', '203.0.113.7'))
      .rejects.toThrow('Certificate is not for host 203.0.113.7');
  });

  it('keeps IPv4 and IPv4-mapped IPv6 identities distinct', async () => {
    await expect(verifyFixtureIdentity('ip-san.generated.pem', '::ffff:192.0.2.10'))
      .rejects.toThrow('Certificate is not for host ::ffff:192.0.2.10');
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

describe('addTrustedRootCAs', () => {
  it('deduplicates additions against the existing global list', () => {
    const g = globalThis as unknown as TrustGlobals;
    g.TLS_ADDITIONAL_ROOT_CA_LIST = [];
    const pem = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----';
    addTrustedRootCAs([pem, pem]);
    addTrustedRootCAs([pem]);
    expect(g.TLS_ADDITIONAL_ROOT_CA_LIST).toEqual([pem]);
  });

  it('initialises the global list if it is missing', () => {
    const g = globalThis as unknown as TrustGlobals;
    delete g.TLS_ADDITIONAL_ROOT_CA_LIST;
    addTrustedRootCAs(['pem-a']);
    expect(g.TLS_ADDITIONAL_ROOT_CA_LIST).toEqual(['pem-a']);
  });
});
