import { expect, test } from 'vitest';

import { isForwardableUpstreamHeader } from '../../../src/data-plane/shared/upstream-response.ts';

test('preserves end-to-end response metadata without forwarding transport or upstream cookies', () => {
  expect(isForwardableUpstreamHeader('x-request-id')).toBe(true);
  expect(isForwardableUpstreamHeader('Retry-After')).toBe(true);
  expect(isForwardableUpstreamHeader('transfer-encoding')).toBe(false);
  expect(isForwardableUpstreamHeader('content-encoding')).toBe(false);
  expect(isForwardableUpstreamHeader('set-cookie')).toBe(false);
});
