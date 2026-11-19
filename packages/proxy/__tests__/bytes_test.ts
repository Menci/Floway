import { describe, expect, it } from 'vitest';

import { encodeAtypAddress } from '../src/bytes.ts';

const SOCKS_ATYP = { v4: 0x01, domain: 0x03, v6: 0x04 };
const VLESS_ATYP = { v4: 0x01, domain: 0x02, v6: 0x03 };

const bytes = (value: Uint8Array): number[] => Array.from(value);

describe('encodeAtypAddress — strict IP literal boundaries', () => {
  it.each([
    '127.1',
    '0x7f.0.0.1',
    '256.0.0.1',
  ])('does not reinterpret non-canonical IPv4 %s as an address literal', host => {
    const encoded = encodeAtypAddress(host, SOCKS_ATYP);
    expect(encoded[0]).toBe(0x03);
    expect(encoded[1]).toBe(host.length);
    expect(new TextDecoder().decode(encoded.subarray(2))).toBe(host);
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
});

describe('encodeAtypAddress — protocol ATYP parity', () => {
  it.each([
    ['SOCKS5', SOCKS_ATYP],
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
