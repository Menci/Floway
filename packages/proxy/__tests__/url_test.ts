import { describe, expect, it } from 'vitest';

import { ProxyUriError } from '../src/uri-error.ts';
import { formatProxyUri, parseProxyUri } from '../src/url.ts';

describe('parseProxyUri', () => {
  it('defaults port to 443 for https without an explicit port', () => {
    expect(parseProxyUri('https://example.com')).toEqual({
      kind: 'http',
      tls: true,
      host: 'example.com',
      port: 443,
      name: 'example.com:443',
    });
  });

  it('throws when http has no explicit port', () => {
    expect(() => parseProxyUri('http://example.com')).toThrow(/port/);
  });

  it('preserves an explicit http port=80 across userinfo, IPv6, and path/query/fragment', () => {
    // The raw-authority scan must walk past userinfo (everything up to the
    // last `@`), the IPv6 envelope (`[::1]`), and stop before the first
    // `/`, `?`, or `#`. Each variant exercises one of those branches.
    expect(parseProxyUri('http://u:p@example.com:80').port).toBe(80);
    expect(parseProxyUri('http://[::1]:80').port).toBe(80);
    expect(parseProxyUri('http://example.com:80/x?y=1#name').port).toBe(80);
  });

  it('parses SIP002 UTF-8 Base64URL userinfo', () => {
    expect(parseProxyUri('ss://YWVzLTI1Ni1nY2065a-G56K8@h:8388'))
      .toMatchObject({ kind: 'ss', method: 'aes-256-gcm', password: '密碼' });
  });

  it('drops a `?sni=` query param on VLESS-TCP+TLS — neither workerd connect(tls=true) nor node:tls servername-via-host supports an SNI override on the wire, so persisting it would be fake config', () => {
    const uri =
      'vless://aaaa-uuid@h:443?type=tcp&security=tls&sni=front#v';
    expect(parseProxyUri(uri)).toEqual({
      kind: 'vless-tcp',
      uuid: 'aaaa-uuid',
      host: 'h',
      port: 443,
      name: 'v',
    });
  });

  it('every parser failure surfaces as ProxyUriError (so callers can discriminate it from arbitrary upstream Errors)', () => {
    const cases: string[] = [
      'weird://x:1',
      'http://example.com',
      'vless://u@h:443?type=tcp&security=reality&sni=s',
      'vless://u@h:443?type=quic&security=tls',
      'ss://invalid-base64@h:443',
      // `new URL` failure: bare string with no scheme. Wrapped so callers
      // never have to special-case TypeError from the URL constructor.
      'not-a-url',
      '',
      // Malformed percent-encoding lands in URL.username / URL.password /
      // URL.hash raw — `decodeURIComponent` would raise URIError otherwise,
      // bypassing the `instanceof ProxyUriError` discriminator.
      'http://u:%zz@h:80',
      'http://h:80#10%',
      // Port 0 is reserved (RFC 6335 §6); the URL parser accepts the literal
      // `:0` even though it never opens a socket.
      'socks5://h:0',
    ];
    for (const uri of cases) {
      expect(() => parseProxyUri(uri)).toThrow(ProxyUriError);
    }
  });
});

describe('formatProxyUri', () => {
  const cases: string[] = [
    'http://user:pass@example.com:3128#name',
    'https://example.com:443',
    'socks5://u:p@1.2.3.4:1080#jp',
    'ss://YWVzLTEyOC1nY206YWJjZA==@h:8388#p',
    'ss://2022-blake3-aes-128-gcm:MTIzNDU2Nzg5MGFiY2RlZg==@1.2.3.4:8388#tag',
    'trojan://pw@example.com:443?sni=example.com&allowInsecure=0#t',
    'vless://aaaa-uuid@h:443?type=tcp&security=tls#v',
    'vless://u@h:443?type=ws&security=tls&host=front&path=%2Fws#vw',
    'vless://u@h:443?type=tcp&security=reality&pbk=PUB&sni=site&sid=ab#r',
  ];

  it.each(cases)('round-trips %s', uri => {
    const config = parseProxyUri(uri);
    const formatted = formatProxyUri(config);
    expect(parseProxyUri(formatted)).toEqual(config);
  });

  it('formats legacy Shadowsocks as UTF-8 unpadded Base64URL', () => {
    expect(formatProxyUri({
      kind: 'ss',
      method: 'aes-256-gcm',
      password: '密碼',
      host: 'h',
      port: 8388,
      name: '',
    })).toBe('ss://YWVzLTI1Ni1nY2065a-G56K8@h:8388');
  });

  it('percent-encodes the standard Base64 PSK in Shadowsocks 2022 userinfo', () => {
    expect(formatProxyUri({
      kind: 'ss2022',
      method: '2022-blake3-aes-256-gcm',
      passwordBase64: 't7XRzLCvgsH4r4r669cyqPnVNFG2c/HC5Tt+MjINJB0=',
      host: 'h',
      port: 8388,
      name: '',
    })).toBe('ss://2022-blake3-aes-256-gcm:t7XRzLCvgsH4r4r669cyqPnVNFG2c%2FHC5Tt%2BMjINJB0%3D@h:8388');
  });
});
