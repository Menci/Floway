import { test } from 'vitest';

import { openaiResponsesInputErrorResult, type OpenAIResponsesServeFailure } from '../../../../src/data-plane/chat/openai-responses/errors.ts';
import { throwChatServeFailure, tryCatchChatServeFailure } from '../../../../src/data-plane/chat/shared/errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const bodyOf = (result: ApiErrorResult): unknown =>
  JSON.parse(new TextDecoder().decode(result.body));

test('round-trips the OpenAI-Responses-only item-not-found failure through throw/catch', () => {
  const failure: OpenAIResponsesServeFailure = { kind: 'item-not-found', itemId: 'msg_abc' };
  const error = assertThrows(() => throwChatServeFailure(failure));
  assertEquals(tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error), failure);
});

test('openaiResponsesInputErrorResult renders an OpenAI 400 invalid_request_error envelope with default `input` param', () => {
  const result = openaiResponsesInputErrorResult(
    new TranslatorInputError("Invalid input item type 'image_generation_call'."),
  );
  assertEquals(result.type, 'api-error');
  assertEquals(result.source, 'gateway');
  assertEquals(result.status, 400);
  assertEquals(bodyOf(result), {
    error: {
      message: "Invalid input item type 'image_generation_call'.",
      type: 'invalid_request_error',
      param: 'input',
      code: null,
    },
  });
});

test('openaiResponsesInputErrorResult carries an explicit error code into the envelope', () => {
  const result = openaiResponsesInputErrorResult(
    new TranslatorInputError("Missing required parameter: 'model'.", { param: 'model', code: 'missing_required_parameter' }),
  );

  assertEquals(bodyOf(result), {
    error: {
      message: "Missing required parameter: 'model'.",
      type: 'invalid_request_error',
      param: 'model',
      code: 'missing_required_parameter',
    },
  });
});

test('openaiResponsesInputErrorResult honors an explicit input param', () => {
  const result = openaiResponsesInputErrorResult(
    new TranslatorInputError('content block not supported', { param: 'input[1].content[0]' }),
  );

  assertEquals(bodyOf(result), {
    error: {
      message: 'content block not supported',
      type: 'invalid_request_error',
      param: 'input[1].content[0]',
      code: null,
    },
  });
});
