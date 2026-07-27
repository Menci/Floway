import { describe, expect, it } from 'vitest';

import { buildTrojanRequestHeader, dialTrojan } from '../../src/protocols/trojan.ts';
import type { TrojanProxyConfig } from '../../src/proxy-config.ts';
import type { DialTarget } from '../../src/types.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';

const target443: DialTarget = { host: 'api.openai.com', port: 443 };

const trojanConfig = (overrides: Partial<TrojanProxyConfig> = {}): TrojanProxyConfig => ({
  kind: 'trojan',
  host: 'proxy.example',
  port: 443,
  password: 'password',
  name: 'trojan-test',
  ...overrides,
});

const PASSWORD = 'password';
// Reference: trojan-go/tunnel/trojan/server_test.go uses
// hex(SHA-224("password")) → "d63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01"
const PASSWORD_SHA224_HEX = 'd63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01';

describe('buildTrojanRequestHeader', () => {
  it('starts with 56 bytes of hex(SHA-224(password)) followed by CRLF', () => {
    const header = buildTrojanRequestHeader(PASSWORD, target443);
    const hashAscii = new TextDecoder().decode(header.subarray(0, 56));
    expect(hashAscii).toBe(PASSWORD_SHA224_HEX);
    expect(header[56]).toBe(0x0d);
    expect(header[57]).toBe(0x0a);
  });

  it('encodes a SOCKS5-style domain target after the CRLF', () => {
    const header = buildTrojanRequestHeader(PASSWORD, target443);
    // CMD=0x01 (CONNECT), ATYP=0x03 (domain), dom_len=14, dom='api.openai.com', port=0x01bb.
    let off = 58;
    expect(header[off++]).toBe(0x01);
    expect(header[off++]).toBe(0x03);
    expect(header[off++]).toBe('api.openai.com'.length);
    const dom = new TextDecoder().decode(header.subarray(off, off + 14));
    expect(dom).toBe('api.openai.com');
    off += 14;
    expect(header[off++]).toBe(0x01);
    expect(header[off++]).toBe(0xbb);
    // Trailing CRLF.
    expect(header[off++]).toBe(0x0d);
    expect(header[off++]).toBe(0x0a);
    expect(header.byteLength).toBe(off);
  });

  it('produces a stable byte sequence for a known password+target vector', () => {
    const header = buildTrojanRequestHeader('hello', { host: 'example.com', port: 80 });
    // hex(SHA-224("hello")) = "ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193"
    const HASH = 'ea09ae9cc6768c50fcee903ed054556e5bfc8347907f12598aa24193';
    const wantPrefix = new TextEncoder().encode(HASH);
    expect(Array.from(header.subarray(0, 56))).toEqual(Array.from(wantPrefix));
    // CRLF | 0x01 | 0x03 | 0x0b | "example.com" | 0x00 0x50 | CRLF
    const tail = [
      0x0d, 0x0a,
      0x01, 0x03, 0x0b,
      ...new TextEncoder().encode('example.com'),
      0x00, 0x50,
      0x0d, 0x0a,
    ];
    expect(Array.from(header.subarray(56))).toEqual(tail);
  });
});

describe('buildTrojanRequestHeader — SHA-224 password vectors', () => {
  // SHA-224 of various password bytes, computed via Node's crypto.
  // Trojan's CRLF + CMD + ATYP + addr + port + CRLF tail starts at offset 56.
  const PASSWORD_VECTORS: Array<[string, string]> = [
    ['', 'd14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f'],
    ['a', 'abd37534c7d9a2efb9465de931cd7055ffdb8879563ae98078d6d6d5'],
    ['p@ssw0rd!', '2d2e8b944f53164ee0aa8b1f98d75713c1b1bc6b9dd67591ef0a29e0'],
    ['with space', '8cde0192998892a0d0144c4c570de8506478a690dc6e82bd74532b26'],
    ['A B\tC', 'da79560bf60049a8757bff9c0611c4fb39b51095f737481ba92cf478'],
  ];

  for (const [password, expected] of PASSWORD_VECTORS) {
    it(`hashes ${JSON.stringify(password)} → ${expected.slice(0, 12)}…`, () => {
      const header = buildTrojanRequestHeader(password, target443);
      const hashAscii = new TextDecoder().decode(header.subarray(0, 56));
      expect(hashAscii).toBe(expected);
    });
  }

  it('hashes a UTF-8 password by encoded byte sequence (not by JS string code units)', () => {
    // "你好世界" → 12 UTF-8 bytes, SHA-224 = b3f5c93d…
    const header = buildTrojanRequestHeader('你好世界', target443);
    const hashAscii = new TextDecoder().decode(header.subarray(0, 56));
    expect(hashAscii).toBe('b3f5c93d7b531d7e29266412f2c842f8a4b7286871f87d259c6eaf07');
  });
});

describe('buildTrojanRequestHeader — port and address variants', () => {
  it('encodes port 1 (BE) as 0x00 0x01', () => {
    const header = buildTrojanRequestHeader('p', { host: 'h', port: 1 });
    // ATYP=0x03, dom_len=1, dom='h', port=0x0001
    expect(header[58]).toBe(0x01);
    expect(header[59]).toBe(0x03);
    expect(header[60]).toBe(0x01);
    expect(header[61]).toBe('h'.charCodeAt(0));
    expect(header[62]).toBe(0x00);
    expect(header[63]).toBe(0x01);
  });

  it('encodes port 65535 as 0xff 0xff', () => {
    const header = buildTrojanRequestHeader('p', { host: 'h', port: 65535 });
    expect(header[62]).toBe(0xff);
    expect(header[63]).toBe(0xff);
  });

  it('rejects port 0 before building any wire bytes (RFC 6335 §6 reserves port 0)', () => {
    expect(() => buildTrojanRequestHeader('p', { host: 'h', port: 0 })).toThrow(
      expect.objectContaining({ name: 'ProxyDialError', stage: 'config', message: expect.stringContaining('1..65535') }),
    );
  });

  it('rejects port 65536 (off by one above the max)', () => {
    expect(() => buildTrojanRequestHeader('p', { host: 'h', port: 65536 })).toThrow(
      expect.objectContaining({ name: 'ProxyDialError', message: expect.stringContaining('1..65535') }),
    );
  });

  it('rejects a negative port', () => {
    expect(() => buildTrojanRequestHeader('p', { host: 'h', port: -1 })).toThrow(
      expect.objectContaining({ name: 'ProxyDialError', message: expect.stringContaining('1..65535') }),
    );
  });

  it('serializes a 255-byte hostname (max dom_len)', () => {
    const host = 'a'.repeat(255);
    const header = buildTrojanRequestHeader('p', { host, port: 443 });
    expect(header[60]).toBe(0xff);
    expect(new TextDecoder().decode(header.subarray(61, 61 + 255))).toBe(host);
  });
});

describe('buildTrojanRequestHeader — total framing layout', () => {
  // Spec: trojan-gfw.github.io/trojan/protocol — 56 hex + CRLF + 1 (CMD) +
  // 1 (ATYP) + addr + 2 (port BE) + CRLF.
  it('total length = 56 + 2 + 1 + 1 + 1 + dom_len + 2 + 2', () => {
    const dom = 'subdomain.example.com';
    const header = buildTrojanRequestHeader('p', { host: dom, port: 443 });
    const want = 56 + 2 + 1 + 1 + 1 + dom.length + 2 + 2;
    expect(header.byteLength).toBe(want);
  });

  it('emits ATYP=0x01 + 4 raw octets for an IPv4 literal target', () => {
    // Reference Trojan clients (trojan-gfw, sing-box) detect literal IPs
    // and emit raw octets matching SOCKS5 numbering (0x01 v4, 0x04 v6);
    // only true hostnames take the 0x03 domain path.
    const header = buildTrojanRequestHeader('p', { host: '1.2.3.4', port: 80 });
    expect(header[59]).toBe(0x01);
    expect(Array.from(header.subarray(60, 64))).toEqual([1, 2, 3, 4]);
    expect(header[64]).toBe(0x00);
    expect(header[65]).toBe(0x50);
    // 56 + CRLF + CMD + ATYP + 4 + port + CRLF.
    expect(header.byteLength).toBe(56 + 2 + 1 + 1 + 4 + 2 + 2);
  });

  it('emits ATYP=0x04 + 16 raw octets for an unbracketed IPv6 literal target', () => {
    const header = buildTrojanRequestHeader('p', { host: '::1', port: 80 });
    expect(header[59]).toBe(0x04);
    expect(header[60 + 15]).toBe(0x01);
    expect(header.byteLength).toBe(56 + 2 + 1 + 1 + 16 + 2 + 2);
  });

  it('emits CMD=0x01 (CONNECT) — UDP ASSOCIATE 0x03 is not implemented', () => {
    const header = buildTrojanRequestHeader('p', target443);
    expect(header[58]).toBe(0x01);
  });

  it('emits ATYP=0x03 (domain) for a true hostname target', () => {
    // SOCKS5 numbering: 0x01 v4, 0x03 domain, 0x04 v6.
    const header = buildTrojanRequestHeader('p', { host: 'example.com', port: 80 });
    expect(header[59]).toBe(0x03);
    expect(header[60]).toBe('example.com'.length);
    expect(new TextDecoder().decode(header.subarray(61, 72))).toBe('example.com');
  });

  it('emits two CRLF terminators — one after the hash, one after the port', () => {
    const header = buildTrojanRequestHeader('p', target443);
    expect(header[56]).toBe(0x0d);
    expect(header[57]).toBe(0x0a);
    expect(header[header.byteLength - 2]).toBe(0x0d);
    expect(header[header.byteLength - 1]).toBe(0x0a);
  });

  it('does not include a payload length prefix — payload concatenates after the trailing CRLF', () => {
    const header = buildTrojanRequestHeader('p', target443);
    // 56 + 2 + 1 + 1 + 1 + 14 + 2 + 2 = 79
    expect(header.byteLength).toBe(79);
  });
});

describe('dialTrojan — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialTrojan(trojanConfig(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('1..65535'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a non-ASCII target host at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialTrojan(trojanConfig(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('ASCII'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it('rejects a 256-byte target host at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialTrojan(trojanConfig(), { host: 'a'.repeat(256), port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('too long'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});
