import { describe, expect, it } from 'vitest';

import { defaultsFor, isValidPort, isValidUuid } from '../../../src/components/proxy-edit/proxy-form-defaults.ts';
import { formatProxyUri, parseProxyUri } from '@floway-dev/proxy/url';

describe('defaultsFor', () => {
  it('seeds a freshly-switched kind with host/port/name carried over and kind-specific fields reset', () => {
    const before = parseProxyUri('vless://aaaa-uuid@h:443?type=tcp&security=tls#mine');
    const after = defaultsFor('trojan', { host: before.host, port: before.port, name: before.name });
    expect(after).toEqual({
      kind: 'trojan',
      host: 'h',
      port: 443,
      name: 'mine',
      password: '',
    });
  });

  it('seeds shadowsocks with an aead method', () => {
    const c = defaultsFor('ss', { host: 'srv', port: 0, name: 'srv:0' });
    expect(c.kind).toBe('ss');
    expect(c).toMatchObject({ method: 'aes-256-gcm', password: '' });
  });

  it('seeds reality with empty required fields the operator must supply', () => {
    expect(defaultsFor('reality', { host: 'srv', port: 0, name: 'srv:0' })).toMatchObject({
      kind: 'reality', uuid: '', publicKey: '', serverName: '',
    });
  });

  it('chooses canonical default ports per kind when current is 0', () => {
    const seed = { host: 'srv', port: 0, name: 'srv:0' };
    expect(defaultsFor('http', seed).port).toBe(8080);
    expect(defaultsFor('https', seed).port).toBe(443);
    expect(defaultsFor('socks5', seed).port).toBe(1080);
    expect(defaultsFor('ss', seed).port).toBe(8388);
    expect(defaultsFor('reality', seed).port).toBe(443);
  });

  it('keeps the existing port when one was already typed', () => {
    expect(defaultsFor('http', { host: 'srv', port: 31280, name: 'srv:0' }).port).toBe(31280);
  });
});

describe('round-trip through formatProxyUri', () => {
  it('a freshly seeded HTTP config formats and parses back without loss', () => {
    const c = defaultsFor('http', { host: 'p.example.com', port: 0, name: 'p.example.com:8080' });
    const uri = formatProxyUri(c);
    expect(parseProxyUri(uri)).toEqual(c);
  });

  it('a freshly seeded VLESS-WS config formats and parses back without loss', () => {
    const c = defaultsFor('vless-ws', { host: 'h', port: 443, name: 'h:443' });
    // Insert a UUID so VLESS dialing-time validation would accept it; the
    // URL grammar itself does not reject empty UUIDs, but we want a realistic
    // round-trip.
    const filled = { ...c, uuid: '00000000-0000-0000-0000-000000000000' };
    const uri = formatProxyUri(filled);
    expect(parseProxyUri(uri)).toEqual(filled);
  });
});

describe('isValidUuid', () => {
  it('accepts canonical hyphenated and unhyphenated forms', () => {
    expect(isValidUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isValidUuid('00000000000000000000000000000000')).toBe(true);
  });

  it('rejects wrong length and non-hex chars', () => {
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('zzzzzzzz-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('isValidPort', () => {
  it('accepts integers in [1, 65535]', () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  it('rejects 0, negatives, fractions, and overflow', () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(443.5)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
  });
});
