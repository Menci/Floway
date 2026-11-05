import { describe, expect, it } from 'vitest';

import { dialHttpConnect } from '../../src/protocols/http-connect.ts';
import { dialReality } from '../../src/protocols/reality.ts';
import { dialShadowsocks2022 } from '../../src/protocols/shadowsocks-2022.ts';
import { dialShadowsocks } from '../../src/protocols/shadowsocks.ts';
import { dialSocks5 } from '../../src/protocols/socks5.ts';
import { dialTrojan } from '../../src/protocols/trojan.ts';
import { dialVlessTcpTls, dialVlessWsTls } from '../../src/protocols/vless.ts';
import type {
  DialTarget,
  HttpProxyConfig,
  RealityProxyConfig,
  Shadowsocks2022ProxyConfig,
  ShadowsocksProxyConfig,
  Socks5ProxyConfig,
  TrojanProxyConfig,
  VlessTcpTlsProxyConfig,
  VlessWsTlsProxyConfig,
} from '../../src/proxy-config.ts';
import type { SocketDial } from '../../src/types.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';

// Every dialer reaches the target through the same two guards in
// `src/dial-target.ts`, so each guard needs one witness per dialer and not one
// per protocol file: the assertions below are identical whichever dialer runs,
// which is the point — a protocol that forgets to call the guard is the only
// way this can fail, and that stays visible as a missing row.
const dialers: readonly { name: string; dial: (target: DialTarget, socketDial: SocketDial) => unknown }[] = [
  { name: 'http-connect', dial: (target, socketDial) => dialHttpConnect(httpConfig(), target, { socketDial }) },
  { name: 'reality', dial: (target, socketDial) => dialReality(realityConfig(), target, { socketDial }) },
  { name: 'ss', dial: (target, socketDial) => dialShadowsocks(ssConfig(), target, { socketDial }) },
  { name: 'ss2022', dial: (target, socketDial) => dialShadowsocks2022(ss2022Config(), target, { socketDial }) },
  { name: 'socks5', dial: (target, socketDial) => dialSocks5(socks5Config(), target, { socketDial }) },
  { name: 'trojan', dial: (target, socketDial) => dialTrojan(trojanConfig(), target, { socketDial }) },
  { name: 'vless-tcp', dial: (target, socketDial) => dialVlessTcpTls(vlessTcpConfig(), target, { socketDial }) },
  { name: 'vless-ws', dial: (target, socketDial) => dialVlessWsTls(vlessWsConfig(), target, { socketDial }) },
];

describe('pre-dial target validation reaches every dialer', () => {
  it.each(dialers)('$name rejects an out-of-range target port at stage=config, before any TCP connect', async ({ dial }) => {
    const fake = makeFakeSocketDial();
    await expect(dial({ host: 'api.openai.com', port: 0 }, fake.socketDial)).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('1..65535'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  it.each(dialers)('$name rejects a non-ASCII target host at stage=config, before any TCP connect', async ({ dial }) => {
    const fake = makeFakeSocketDial();
    await expect(dial({ host: '例え.jp', port: 443 }, fake.socketDial)).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('ASCII'),
    });
    expect(fake.connectCount()).toBe(0);
  });

  // Only the SOCKS-style dialers pass `maxBytes: 255`, because only they frame
  // the host as a 1-byte length prefix; the others accept a longer name.
  it.each(dialers.filter(({ name }) => name === 'ss2022' || name === 'socks5' || name === 'trojan' || name === 'vless-tcp' || name === 'vless-ws'))(
    '$name rejects a 256-byte target host at stage=config, before any TCP connect',
    async ({ dial }) => {
      const fake = makeFakeSocketDial();
      await expect(dial({ host: 'a'.repeat(256), port: 443 }, fake.socketDial)).rejects.toMatchObject({
        name: 'ProxyDialError',
        stage: 'config',
        message: expect.stringContaining('too long'),
      });
      expect(fake.connectCount()).toBe(0);
    },
  );
});

const httpConfig = (): HttpProxyConfig => ({ kind: 'http', host: 'proxy.example', port: 8080, name: 'http' });

const realityConfig = (): RealityProxyConfig => ({
  kind: 'reality',
  uuid: '11111111-2222-3333-4444-555555555555',
  publicKey: 'A'.repeat(43),
  serverName: 'www.cloudflare.com',
  host: 'h',
  port: 443,
  name: 'r',
});

const ssConfig = (): ShadowsocksProxyConfig => ({
  kind: 'ss',
  method: 'aes-128-gcm',
  password: 'shadow',
  host: 'proxy.example',
  port: 8388,
  name: 'ss',
});

const ss2022Config = (): Shadowsocks2022ProxyConfig => ({
  kind: 'ss2022',
  method: '2022-blake3-aes-128-gcm',
  passwordBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  host: 'proxy.example',
  port: 8388,
  name: 'ss2022',
});

const socks5Config = (): Socks5ProxyConfig => ({ kind: 'socks5', host: 'proxy.example', port: 1080, name: 'socks5' });

const trojanConfig = (): TrojanProxyConfig => ({
  kind: 'trojan',
  password: 'secret',
  host: 'proxy.example',
  port: 443,
  name: 'trojan',
});

const vlessTcpConfig = (): VlessTcpTlsProxyConfig => ({
  kind: 'vless-tcp',
  host: 'proxy.example',
  port: 443,
  uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
  name: 'vless-test',
});

const vlessWsConfig = (): VlessWsTlsProxyConfig => ({
  kind: 'vless-ws',
  host: 'proxy.example',
  port: 443,
  uuid: 'b831381d-6324-4d53-ad4f-8cda48b30811',
  name: 'vless-ws-test',
  path: '/ws',
});
