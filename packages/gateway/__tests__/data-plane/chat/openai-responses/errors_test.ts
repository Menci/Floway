// The OpenAI Responses-only refusal, through the same throw/catch. Its shape is the reason the
// mechanism is generic over the failure type: the store finds the missing item deep inside a
// walk, and the stage that started the walk is what answers.

import { test } from 'vitest';

import { inputErrorEnvelope, type OpenAIResponsesServeFailure } from '../../../../src/data-plane/chat/openai-responses/errors.ts';
import { throwChatServeFailure, tryCatchChatServeFailure } from '../../../../src/data-plane/chat/shared/errors.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('round-trips the OpenAI Responses-only item-not-found failure through throw/catch', () => {
  const failure: OpenAIResponsesServeFailure = { kind: 'item-not-found', itemId: 'msg_abc' };
  const error = assertThrows(() => throwChatServeFailure(failure));
  assertEquals(tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error), failure);
});

test('inputErrorEnvelope renders an OpenAI invalid_request_error envelope with default `input` param', () => {
  assertEquals(inputErrorEnvelope({ message: "Invalid input item type 'image_generation_call'." }), {
    error: {
      message: "Invalid input item type 'image_generation_call'.",
      type: 'invalid_request_error',
      param: 'input',
      code: null,
    },
  });
});

test('inputErrorEnvelope carries an explicit error code into the envelope', () => {
  assertEquals(inputErrorEnvelope({ message: "Missing required parameter: 'model'.", param: 'model', code: 'missing_required_parameter' }), {
    error: {
      message: "Missing required parameter: 'model'.",
      type: 'invalid_request_error',
      param: 'model',
      code: 'missing_required_parameter',
    },
  });
});

test('inputErrorEnvelope honors an explicit input param', () => {
  assertEquals(inputErrorEnvelope({ message: 'content block not supported', param: 'input[1].content[0]' }), {
    error: {
      message: 'content block not supported',
      type: 'invalid_request_error',
      param: 'input[1].content[0]',
      code: null,
    },
  });
});
