import { describe, expect, it } from 'vitest';

import { ProxyUriError } from '../src/errors.ts';
import { formatProxyUri, parseProxyUri } from '../src/url.ts';

describe('parseProxyUri', () => {
  it('parses HTTP CONNECT plain', () => {
    expect(parseProxyUri('http://user:pass@example.com:3128#name')).toEqual({
      kind: 'http',
      tls: false,
      host: 'example.com',
      port: 3128,
      username: 'user',
      password: 'pass',
      name: 'name',
    });
  });

  it('parses HTTPS CONNECT', () => {
    expect(parseProxyUri('https://example.com:443')).toEqual({
      kind: 'http',
      tls: true,
      host: 'example.com',
      port: 443,
      name: 'example.com:443',
    });
  });

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

  it('preserves an explicit http port=80 that the URL constructor strips', () => {
    // `new URL('http://host:80/').port === ''` — same shape as a port-omitted
    // URI. The parser reaches into the raw input so an HTTP proxy literally
    // listening on 80 isn't mis-rejected as "port required".
    expect(parseProxyUri('http://example.com:80')).toEqual({
      kind: 'http',
      tls: false,
      host: 'example.com',
      port: 80,
      name: 'example.com:80',
    });
  });

  it('preserves an explicit http port=80 across userinfo, IPv6, and path/query/fragment', () => {
    // The raw-authority scan must walk past userinfo (everything up to the
    // last `@`), the IPv6 envelope (`[::1]`), and stop before the first
    // `/`, `?`, or `#`. Each variant exercises one of those branches.
    expect(parseProxyUri('http://u:p@example.com:80').port).toBe(80);
    expect(parseProxyUri('http://[::1]:80').port).toBe(80);
    expect(parseProxyUri('http://example.com:80/x?y=1#name').port).toBe(80);
  });

  it('parses SOCKS5 with auth', () => {
    expect(parseProxyUri('socks5://u:p@1.2.3.4:1080#jp')).toEqual({
      kind: 'socks5',
      host: '1.2.3.4',
      port: 1080,
      username: 'u',
      password: 'p',
      name: 'jp',
    });
  });

  it('parses Shadowsocks legacy base64(method:password)', () => {
    // base64('aes-256-gcm:secret') = 'YWVzLTI1Ni1nY206c2VjcmV0'
    expect(parseProxyUri('ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#tag'))
      .toEqual({
        kind: 'ss',
        method: 'aes-256-gcm',
        password: 'secret',
        host: '1.2.3.4',
        port: 8388,
        name: 'tag',
      });
  });

  it('parses Shadowsocks legacy when base64 padding survives the URL parser as %3D', () => {
    // base64('aes-128-gcm:abcd') = 'YWVzLTEyOC1nY206YWJjZA==' — non-quad
    // input bytes force `=` padding, which the WHATWG URL constructor
    // percent-encodes inside userinfo to %3D before atob ever sees it.
    expect(parseProxyUri('ss://YWVzLTEyOC1nY206YWJjZA==@h:8388#p'))
      .toEqual({
        kind: 'ss',
        method: 'aes-128-gcm',
        password: 'abcd',
        host: 'h',
        port: 8388,
        name: 'p',
      });
  });

  it('parses Shadowsocks 2022', () => {
    // userinfo = '2022-blake3-aes-128-gcm:<base64key>'
    expect(parseProxyUri(
      'ss://2022-blake3-aes-128-gcm:MTIzNDU2Nzg5MGFiY2RlZg==@1.2.3.4:8388#tag',
    )).toEqual({
      kind: 'ss2022',
      method: '2022-blake3-aes-128-gcm',
      passwordBase64: 'MTIzNDU2Nzg5MGFiY2RlZg==',
      host: '1.2.3.4',
      port: 8388,
      name: 'tag',
    });
  });

  it('parses Trojan', () => {
    expect(parseProxyUri(
      'trojan://pw@example.com:443?sni=example.com&allowInsecure=0#t',
    )).toEqual({
      kind: 'trojan',
      password: 'pw',
      host: 'example.com',
      port: 443,
      sni: 'example.com',
      allowInsecure: false,
      name: 't',
    });
  });

  it('parses VLESS TCP+TLS', () => {
    const uri =
      'vless://aaaa-uuid@h:443?type=tcp&security=tls#v';
    expect(parseProxyUri(uri)).toEqual({
      kind: 'vless-tcp',
      uuid: 'aaaa-uuid',
      host: 'h',
      port: 443,
      name: 'v',
    });
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

  it('parses VLESS WS+TLS', () => {
    const uri =
      'vless://u@h:443?type=ws&security=tls&host=front&path=%2Fws#vw';
    expect(parseProxyUri(uri)).toEqual({
      kind: 'vless-ws',
      uuid: 'u',
      host: 'h',
      port: 443,
      wsHost: 'front',
      path: '/ws',
      name: 'vw',
    });
  });

  it('drops a `?sni=` query param on VLESS-WS+TLS — the outer TLS rides `socketDial(tls=true)` which pins SNI to the URL host, so an override would never reach the wire', () => {
    const uri =
      'vless://u@h:443?type=ws&security=tls&host=front&path=%2Fws&sni=ignored#vw';
    expect(parseProxyUri(uri)).toEqual({
      kind: 'vless-ws',
      uuid: 'u',
      host: 'h',
      port: 443,
      wsHost: 'front',
      path: '/ws',
      name: 'vw',
    });
  });

  it('parses VLESS REALITY', () => {
    const uri =
      'vless://u@h:443?type=tcp&security=reality&pbk=PUB&sni=site&sid=ab#r';
    expect(parseProxyUri(uri)).toEqual({
      kind: 'reality',
      uuid: 'u',
      host: 'h',
      port: 443,
      publicKey: 'PUB',
      serverName: 'site',
      shortId: 'ab',
      name: 'r',
    });
  });

  it('throws on unknown scheme', () => {
    expect(() => parseProxyUri('weird://x:1')).toThrow(/scheme/i);
  });

  it('throws on missing required REALITY pbk', () => {
    expect(() =>
      parseProxyUri('vless://u@h:443?type=tcp&security=reality&sni=s')).toThrow(/pbk/);
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
    'ss://YWVzLTI1Ni1nY206c2VjcmV0@1.2.3.4:8388#tag',
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
});
