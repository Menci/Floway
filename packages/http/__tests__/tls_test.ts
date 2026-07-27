import { describe, expect, it } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import { addTrustedRootCAs, userspaceTls } from '../src/tls.ts';

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
    const deadline = Date.now() + 1000;
    while (fake.written().byteLength < 5 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5));
    }
    const written = fake.written();
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

    const deadline = Date.now() + 1000;
    while (fake.written().byteLength < 9 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5));
    }
    const written = fake.written();
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

    const deadline = Date.now() + 1000;
    while (fake.written().byteLength < 5 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5));
    }
    expect(fake.written()[0]).toBe(0x16);

    ac.abort(new DOMException('done', 'AbortError'));
    await handshake.catch(() => { /* expected */ });
  });

  it('places the SNI hostname inside the ClientHello extension block', async () => {
    // RFC 6066 §3: server_name extension carries the host as a length-
    // prefixed name list. We grep for the host bytes in the emitted record;
    // they must appear because reclaim copies the SNI from opts.host.
    const fake = makeFakeDuplex();
    const ac = new AbortController();
    const host = 'sni-test.example';
    const handshake = userspaceTls(
      { readable: fake.readable, writable: fake.writable },
      { host, signal: ac.signal },
    );
    handshake.catch(() => { /* expected */ });

    const deadline = Date.now() + 1000;
    while (fake.written().byteLength < 200 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5));
    }
    const written = fake.written();
    const text = new TextDecoder('latin1').decode(written);
    expect(text).toContain(host);

    ac.abort(new DOMException('done', 'AbortError'));
    await handshake.catch(() => { /* expected */ });
  });
});

interface TrustGlobals { TLS_ADDITIONAL_ROOT_CA_LIST?: string[] }

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
