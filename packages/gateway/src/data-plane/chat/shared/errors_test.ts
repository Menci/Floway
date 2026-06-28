import { test } from 'vitest';

import { type ChatServeFailure, throwChatServeFailure, tryCatchChatServeFailure } from './errors.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const cases: readonly ChatServeFailure[] = [
  { kind: 'model-missing', model: 'gpt-9', failedUpstreams: [] },
  { kind: 'model-missing', model: 'gpt-9', failedUpstreams: ['Azure prod'] },
  { kind: 'model-unsupported', model: 'gpt-9', failedUpstreams: [] },
  { kind: 'model-unsupported', model: 'gpt-9', failedUpstreams: ['Azure prod', 'Custom'] },
  { kind: 'item-not-found', itemId: 'msg_abc' },
  { kind: 'routing-unavailable', message: 'no upstream can serve this' },
];

for (const failure of cases) {
  const label = 'failedUpstreams' in failure && failure.failedUpstreams.length
    ? `${failure.kind} (with ${failure.failedUpstreams.length} failed upstream(s))`
    : failure.kind;
  test(`round-trips ${label} through throw/catch`, () => {
    const error = assertThrows(() => throwChatServeFailure(failure));
    assertEquals(tryCatchChatServeFailure(error), failure);
  });
}

test('returns null for an error not raised by throwChatServeFailure', () => {
  assertEquals(tryCatchChatServeFailure(new Error('something else')), null);
  assertEquals(tryCatchChatServeFailure('not even an error'), null);
  assertEquals(tryCatchChatServeFailure(null), null);
});
