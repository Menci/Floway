import { test } from 'vitest';

import { isIpV4, isIpV6 } from '../../../src/control-plane/proxies/egress-probe.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('isIpV4 rejects leading zeros so no octet can be read as octal', () => {
  assertEquals(isIpV4('192.168.001.1'), false);
  assertEquals(isIpV4('010.0.0.1'), false);
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
