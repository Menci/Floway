import { test } from 'vitest';

import { ANCHORS, isIpV4, isIpV6, type AnchorName } from '../../../src/control-plane/proxies/egress-probe.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('every anchor is reachable over the HTTPS port the probe dials with TLS', () => {
  // testProxy dials each anchor with `tls: true` unconditionally, so an
  // anchor on any other port would be handed a TLS handshake it cannot answer.
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
