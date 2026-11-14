// The one refusal that travels as a throw, and the guard that keeps it from catching anything
// else. What it carries has to survive the trip intact: the message names which carried target
// went missing, and only the selection several frames down knows that.

import { test } from 'vitest';

import { type ChatServeFailure, throwChatServeFailure, tryCatchChatServeFailure } from '../../../../src/data-plane/chat/shared/errors.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('round-trips routing-unavailable through throw/catch', () => {
  const failure: ChatServeFailure = { kind: 'routing-unavailable', message: 'no upstream can serve this' };
  const error = assertThrows(() => throwChatServeFailure(failure));
  assertEquals(tryCatchChatServeFailure(error), failure);
});

test('returns null for an error not raised by throwChatServeFailure', () => {
  assertEquals(tryCatchChatServeFailure(new Error('something else')), null);
  assertEquals(tryCatchChatServeFailure('not even an error'), null);
  assertEquals(tryCatchChatServeFailure(null), null);
});
