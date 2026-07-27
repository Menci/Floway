import { describe, expect, it } from 'vitest';

import { dialVlessTcpTls, dialVlessWsTls } from '../../src/protocols/vless.ts';
import type { VlessTcpTlsProxyConfig, VlessWsTlsProxyConfig } from '../../src/proxy-config.ts';
import { makeFakeSocketDial } from '../test-utils/fake-socket-dial.ts';

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

const vlessTcpConfig = (overrides: Partial<VlessTcpTlsProxyConfig> = {}): VlessTcpTlsProxyConfig => ({
  kind: 'vless-tcp',
  host: 'proxy.example',
  port: 443,
  uuid: UUID,
  name: 'vless-test',
  ...overrides,
});

const vlessWsConfig = (overrides: Partial<VlessWsTlsProxyConfig> = {}): VlessWsTlsProxyConfig => ({
  kind: 'vless-ws',
  host: 'proxy.example',
  port: 443,
  uuid: UUID,
  name: 'vless-ws-test',
  path: '/ws',
  ...overrides,
});

describe('dialVlessTcpTls — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialVlessTcpTls(vlessTcpConfig(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
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
      dialVlessTcpTls(vlessTcpConfig(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
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
      dialVlessTcpTls(vlessTcpConfig(), { host: 'a'.repeat(256), port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('too long'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});

describe('dialVlessWsTls — pre-dial target validation', () => {
  it('rejects an out-of-range target port at stage=config, before any TCP connect', async () => {
    const fake = makeFakeSocketDial();
    await expect(
      dialVlessWsTls(vlessWsConfig(), { host: 'api.openai.com', port: 0 }, { socketDial: fake.socketDial }),
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
      dialVlessWsTls(vlessWsConfig(), { host: '例え.jp', port: 443 }, { socketDial: fake.socketDial }),
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
      dialVlessWsTls(vlessWsConfig(), { host: 'a'.repeat(256), port: 443 }, { socketDial: fake.socketDial }),
    ).rejects.toMatchObject({
      name: 'ProxyDialError',
      stage: 'config',
      message: expect.stringContaining('too long'),
    });
    expect(fake.connectCount()).toBe(0);
  });
});
