import { test } from 'vitest';

import { appendFailedUpstreams } from './failed-upstreams.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('returns the message unchanged when no upstream failed', () => {
  assertEquals(appendFailedUpstreams('Model X is not available.', []), 'Model X is not available.');
});

test('inserts the parenthetical before a trailing period', () => {
  assertEquals(
    appendFailedUpstreams('Model X is not available.', ['Azure prod']),
    'Model X is not available (models from upstream(s) "Azure prod" failed to load).',
  );
});

test('joins multiple names with commas in the supplied order', () => {
  assertEquals(
    appendFailedUpstreams('Model X is not available.', ['a', 'b', 'c']),
    'Model X is not available (models from upstream(s) "a", "b", "c" failed to load).',
  );
});

test('appends without inserting when the message has no trailing period', () => {
  assertEquals(
    appendFailedUpstreams('Model X is not available', ['a']),
    'Model X is not available (models from upstream(s) "a" failed to load)',
  );
});
