import { expect, test, vi } from 'vitest';

import { ANCHORS, isIpV4, isIpV6, probeProxyEgress, type AnchorName } from '../../../src/control-plane/proxies/egress-probe.ts';
import { assertEquals } from '@floway-dev/test-utils';
import { ProxyDialError, type ProxyConfig, type SocketDial } from '@floway-dev/proxy';

const proxyConfig: ProxyConfig = {
  kind: 'http',
  host: 'proxy.example.test',
  port: 3128,
  name: 'proxy.example.test:3128',
  tls: false,
};

const socketDial: SocketDial = {
  connect: async () => {
    throw new Error('the injected request runner must not open a socket');
  },
};

test('every anchor uses the HTTPS port required by the probe target', () => {
  for (const name of Object.keys(ANCHORS) as AnchorName[]) {
    assertEquals(ANCHORS[name].port, 443, `${name} must stay on the HTTPS port`);
  }
});

test('isIpV4 accepts a dotted quad and rejects out-of-range octets', () => {
  assertEquals(isIpV4('203.0.113.7'), true);
  assertEquals(isIpV4('0.0.0.0'), true);
  assertEquals(isIpV4('255.255.255.255'), true);
  assertEquals(isIpV4('256.0.0.1'), false);
  assertEquals(isIpV4('999.999.999.999'), false);
});

test('isIpV4 rejects leading zeros so no octet can be read as octal', () => {
  assertEquals(isIpV4('192.168.001.1'), false);
  assertEquals(isIpV4('010.0.0.1'), false);
});

test('isIpV4 rejects anything that is not exactly four numeric groups', () => {
  assertEquals(isIpV4('1.2.3'), false);
  assertEquals(isIpV4('1.2.3.4.5'), false);
  assertEquals(isIpV4('1.2.3.'), false);
  assertEquals(isIpV4('1.2.3.x'), false);
  assertEquals(isIpV4(''), false);
});

test('isIpV6 accepts full form, `::` shorthand, and an embedded v4 tail', () => {
  assertEquals(isIpV6('2001:0db8:0000:0000:0000:ff00:0042:8329'), true);
  assertEquals(isIpV6('2001:db8::1'), true);
  assertEquals(isIpV6('::1'), true);
  assertEquals(isIpV6('fe80::'), true);
  assertEquals(isIpV6('::'), true);
  assertEquals(isIpV6('::ffff:192.0.2.128'), true);
  assertEquals(isIpV6('1:2:3:4:5:6:7::'), true);
  assertEquals(isIpV6('1:2:3:4:5:6:192.0.2.128'), true);
});

test('isIpV6 rejects more than one `::` shorthand', () => {
  assertEquals(isIpV6('aaaa::bbbb::cccc'), false);
  // A single `:::` run matches the `::` scan only once, so it needs its own
  // guard to stay out of the accepted grammar.
  assertEquals(isIpV6('2001:::1'), false);
});

test('isIpV6 rejects wrong group counts and oversized groups', () => {
  assertEquals(isIpV6('2001:db8:0:0:0:ff00:42'), false);
  assertEquals(isIpV6('1:2:3:4:5:6:7:8:9'), false);
  assertEquals(isIpV6('20011:db8::1'), false);
  assertEquals(isIpV6('2001:db8::xyz'), false);
  // Eight explicit groups leave nothing for `::` to elide.
  assertEquals(isIpV6('1:2:3:4::5:6:7:8'), false);
  assertEquals(isIpV6('1:2:3:4:5:6:7:192.0.2.128'), false);
});

test('isIpV6 rejects a malformed embedded v4 tail', () => {
  assertEquals(isIpV6('::ffff:999.0.2.128'), false);
  assertEquals(isIpV6('::ffff:192.0.2'), false);
});

test('isIpV6 rejects a bare v4 address', () => {
  assertEquals(isIpV6('203.0.113.7'), false);
});

test('neither validator accepts an HTML page an anchor could return', () => {
  // This pair is what stops a captive portal or error page from being echoed
  // back to the operator as the proxy's egress IP.
  const page = '<a href="http://198.51.100.20/">198.51.100.20</a>';
  assertEquals(isIpV4(page), false);
  assertEquals(isIpV6(page), false);

  const error = '<html><head><title>Error: 502</title></head></html>';
  assertEquals(isIpV4(error), false);
  assertEquals(isIpV6(error), false);
});

test('probe selects the requested anchor, forwards the dial deadline, and trims the IP body', async () => {
  let observed: unknown;
  const result = await probeProxyEgress(
    { config: proxyConfig, anchorName: 'aws', dialTimeoutSeconds: 12 },
    {
      socketDial,
      runProxiedRequest: async (config, target, request, options) => {
        observed = { config, target, request, options };
        return new Response('203.0.113.7\n');
      },
    },
  );

  expect(result).toEqual({ ok: true, egress_ip: '203.0.113.7' });
  expect(observed).toEqual({
    config: proxyConfig,
    target: { host: 'checkip.amazonaws.com', port: 443, tls: true },
    request: {
      method: 'GET',
      path: '/',
      headers: { 'User-Agent': 'floway-proxy-test/1' },
    },
    options: { socketDial, dialTimeoutMs: 12_000 },
  });
});

test('probe accepts IPv6 and rejects IPv4 from the IPv6-only anchor', async () => {
  const run = async (body: string) => await probeProxyEgress(
    { config: proxyConfig, anchorName: 'ident.me-v6' },
    { socketDial, runProxiedRequest: async () => new Response(body) },
  );

  await expect(run('2001:db8::7\n')).resolves.toEqual({ ok: true, egress_ip: '2001:db8::7' });
  await expect(run('203.0.113.7')).resolves.toEqual({
    ok: false,
    error: 'v6 anchor returned a v4 address (203.0.113.7); proxy has no v6 path',
  });
});

test('probe cancels a non-success anchor body before returning the status error', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('upstream error'));
    },
    cancel,
  });

  const result = await probeProxyEgress(
    { config: proxyConfig, anchorName: 'ipify' },
    { socketDial, runProxiedRequest: async () => new Response(body, { status: 503 }) },
  );

  expect(result).toEqual({ ok: false, error: 'anchor returned status 503' });
  expect(cancel).toHaveBeenCalledOnce();
});

test('probe reads only the bounded prefix and promptly cancels an endless non-IP body', async () => {
  let pulls = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(64).fill('x'.charCodeAt(0)));
    },
    cancel,
  });

  const result = await probeProxyEgress(
    { config: proxyConfig, anchorName: 'ipify' },
    { socketDial, runProxiedRequest: async () => new Response(body) },
  );

  expect(result).toEqual({ ok: false, error: `anchor returned non-IP body: ${'x'.repeat(80)}` });
  expect(pulls).toBeLessThan(10);
  expect(cancel).toHaveBeenCalledOnce();
});

test('probe reports typed dial failures and propagates programmer errors', async () => {
  const dialError = await probeProxyEgress(
    { config: proxyConfig, anchorName: 'ipify' },
    {
      socketDial,
      runProxiedRequest: async () => {
        throw new ProxyDialError('connection refused', 'tcp-connect');
      },
    },
  );
  expect(dialError).toEqual({ ok: false, error: '[tcp-connect] connection refused' });

  const programmerError = new TypeError('broken probe dependency');
  await expect(probeProxyEgress(
    { config: proxyConfig, anchorName: 'ipify' },
    { socketDial, runProxiedRequest: async () => { throw programmerError; } },
  )).rejects.toBe(programmerError);
});
