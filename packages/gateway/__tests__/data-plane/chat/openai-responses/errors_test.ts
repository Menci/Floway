// The OpenAI Responses-only refusal, through the same throw/catch. Its shape is the reason the
// mechanism is generic over the failure type: the store finds the missing item deep inside a
// walk, and the stage that started the walk is what answers.

import { test } from 'vitest';

import type { OpenAIResponsesServeFailure } from '../../../../src/data-plane/chat/openai-responses/errors.ts';
import { throwChatServeFailure, tryCatchChatServeFailure } from '../../../../src/data-plane/chat/shared/errors.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('round-trips the OpenAI Responses-only item-not-found failure through throw/catch', () => {
  const failure: OpenAIResponsesServeFailure = { kind: 'item-not-found', itemId: 'msg_abc' };
  const error = assertThrows(() => throwChatServeFailure(failure));
  assertEquals(tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error), failure);
});
