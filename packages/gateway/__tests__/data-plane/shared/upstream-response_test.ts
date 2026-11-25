import { expect, test } from 'vitest';

import { isForwardableUpstreamHeader } from '../../../src/data-plane/shared/upstream-response.ts';

test('upstream response header policy preserves vendor metadata and blocks unsafe fields', () => {
  expect(isForwardableUpstreamHeader('x-api-warning')).toBe(true);
  expect(isForwardableUpstreamHeader('content-length')).toBe(false);
  expect(isForwardableUpstreamHeader('set-cookie')).toBe(false);
});
