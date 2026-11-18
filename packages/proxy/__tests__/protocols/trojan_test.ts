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

// Reference: trojan-go/tunnel/trojan/server_test.go uses
// hex(SHA-224("password")) → "d63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01"
const PASSWORD_SHA224_HEX = 'd63dc919e201d7bc4c825630d2cf25fdc93d4b2f0d46706d29038d01';

describe('buildTrojanRequestHeader', () => {
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

  it('hashes a UTF-8 password by encoded byte sequence (not by JS string code units)', () => {
    const header = buildTrojanRequestHeader('你好世界', target443);
    expect(new TextDecoder().decode(header.subarray(0, 56))).toBe('b3f5c93d7b531d7e29266412f2c842f8a4b7286871f87d259c6eaf07');
  });
});

describe('dialTrojan — outer TLS', () => {
  it('upgrades the plaintext proxy connection with the configured SNI', async () => {
    const fake = makeFakeSocketDial();
    fake.acceptNextUpgrade();

    const result = await dialTrojan(
      trojanConfig({ sni: 'front.example' }),
      target443,
      { socketDial: fake.socketDial },
    );

    expect(fake.tlsUpgrades).toHaveLength(1);
    expect(fake.tlsUpgrades[0]!.opts).toMatchObject({ host: 'front.example' });
    // The Trojan header belongs to the tunneled leg, not the TLS handshake.
    expect(new TextDecoder().decode(result.prefix!.subarray(0, 56))).toBe(PASSWORD_SHA224_HEX);
  });

  it('passes the operator insecure flag through to the upgrade', async () => {
    const fake = makeFakeSocketDial();
    fake.acceptNextUpgrade();

    await dialTrojan(trojanConfig({ allowInsecure: true }), target443, { socketDial: fake.socketDial });

    expect(fake.tlsUpgrades[0]!.opts.insecure).toBe(true);
  });

  it('tags a failed outer handshake as stage=outer-tls', async () => {
    const cause = new Error('certificate rejected');
    const fake = makeFakeSocketDial();
    fake.failNextUpgrade(cause);

    await expect(dialTrojan(trojanConfig(), target443, { socketDial: fake.socketDial }))
      .rejects.toMatchObject({
        name: 'ProxyDialError',
        stage: 'outer-tls',
        cause,
      });
  });
});
