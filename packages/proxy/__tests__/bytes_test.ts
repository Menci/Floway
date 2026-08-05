import { describe, expect, it } from 'vitest';

import { base64DecodeBytes, base64EncodeBytes, base64UrlDecodeBytes, encodeAtypAddress, hexDecode } from '../src/bytes.ts';

describe('base codecs', () => {
  it('matches RFC 4648 vectors and accepts the established external forms', () => {
    expect(base64EncodeBytes(new TextEncoder().encode('foobar'))).toBe('Zm9vYmFy');
    expect(base64DecodeBytes(' Zm9v\nYg\t')).toEqual(new TextEncoder().encode('foob'));
    expect(base64UrlDecodeBytes('-_8')).toEqual(new Uint8Array([0xfb, 0xff]));
    expect(base64UrlDecodeBytes('/+8=')).toEqual(new Uint8Array([0xff, 0xef]));
    expect(hexDecode('00ABff')).toEqual(new Uint8Array([0x00, 0xab, 0xff]));
  });

  it('preserves forgiving-base64 trailing-bit acceptance for legacy and SS-2022 values', () => {
    expect(new TextDecoder().decode(base64DecodeBytes('Zh=='))).toBe('f');
    expect(new TextDecoder().decode(base64DecodeBytes('MDEyMzQ1Njc4OWFiY2RlZh=='))).toBe('0123456789abcdef');
    expect(base64UrlDecodeBytes('-x')).toEqual(new Uint8Array([0xfb]));
    expect(() => base64DecodeBytes('Zg=')).toThrow();
  });

  it('round-trips a large byte buffer without binary-string conversion', () => {
    // 128 KiB remains above engines' argument-spread limits, which is
    // the failure mode this regression guards, without spending four times
    // the allocation and codec work on every suite run.
    const bytes = Uint8Array.from({ length: 128 * 1024 }, (_, index) => index & 0xff);
    const decoded = base64DecodeBytes(base64EncodeBytes(bytes));
    expect(decoded).toHaveLength(bytes.length);
    expect(decoded.every((byte, index) => byte === bytes[index])).toBe(true);
  });
});

const SOCKS_ATYP = { v4: 0x01, domain: 0x03, v6: 0x04 };
const VLESS_ATYP = { v4: 0x01, domain: 0x02, v6: 0x03 };

const bytes = (value: Uint8Array): number[] => Array.from(value);

describe('encodeAtypAddress — strict IP literal boundaries', () => {
  it.each([
    ['0.0.0.0', [0, 0, 0, 0]],
    ['1.2.3.4', [1, 2, 3, 4]],
    ['255.255.255.255', [255, 255, 255, 255]],
  ] as const)('encodes four-part decimal IPv4 %s as raw octets', (host, octets) => {
    expect(bytes(encodeAtypAddress(host, SOCKS_ATYP))).toEqual([0x01, ...octets]);
  });

  it.each([
    '127.1',
    '2130706433',
    '0177.0.0.1',
    '0x7f.0.0.1',
    '127.00.0.1',
    '256.0.0.1',
  ])('does not reinterpret non-canonical IPv4 %s as an address literal', host => {
    const encoded = encodeAtypAddress(host, SOCKS_ATYP);
    expect(encoded[0]).toBe(0x03);
    expect(encoded[1]).toBe(host.length);
    expect(new TextDecoder().decode(encoded.subarray(2))).toBe(host);
  });

  it.each([
    ['::', new Array<number>(16).fill(0)],
    ['::1', [...new Array<number>(15).fill(0), 1]],
    ['2001:db8:0:1:2:3:4:5', [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5]],
    ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', new Array<number>(16).fill(0xff)],
  ] as const)('encodes IPv6 %s as 16 network-order octets', (host, octets) => {
    expect(bytes(encodeAtypAddress(host, SOCKS_ATYP))).toEqual([0x04, ...octets]);
  });

  it('preserves the distinct wire bits of IPv4-compatible and IPv4-mapped IPv6', () => {
    const compatible = bytes(encodeAtypAddress('::192.0.2.128', SOCKS_ATYP));
    const mapped = bytes(encodeAtypAddress('::ffff:192.0.2.128', SOCKS_ATYP));

    expect(compatible).toEqual([
      0x04,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 192, 0, 2, 128,
    ]);
    expect(mapped).toEqual([
      0x04,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0xff, 0xff, 192, 0, 2, 128,
    ]);
    expect(compatible).not.toEqual(mapped);
  });

  it.each([
    'fe80::1%eth0',
    'fe80::1%25eth0',
    '::ffff:192.168.001.1',
    '::ffff:0xc0.168.1.1',
  ])('keeps scoped or non-canonical IPv6 %s off the literal path', host => {
    const encoded = encodeAtypAddress(host, SOCKS_ATYP);
    expect(encoded[0]).toBe(0x03);
    expect(new TextDecoder().decode(encoded.subarray(2))).toBe(host);
  });
});

describe('encodeAtypAddress — protocol ATYP parity', () => {
  it.each([
    ['SOCKS5', SOCKS_ATYP],
    ['Shadowsocks', SOCKS_ATYP],
    ['Shadowsocks 2022', SOCKS_ATYP],
    ['Trojan', SOCKS_ATYP],
    ['VLESS', VLESS_ATYP],
  ] as const)('preserves %s IPv4/domain/IPv6 discriminants', (_protocol, atyp) => {
    expect(bytes(encodeAtypAddress('1.2.3.4', atyp))).toEqual([atyp.v4, 1, 2, 3, 4]);
    expect(bytes(encodeAtypAddress('::1', atyp))).toEqual([
      atyp.v6,
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 1,
    ]);

    const domain = encodeAtypAddress('example.com', atyp);
    expect(domain[0]).toBe(atyp.domain);
    expect(domain[1]).toBe(11);
    expect(new TextDecoder().decode(domain.subarray(2))).toBe('example.com');
  });
});
