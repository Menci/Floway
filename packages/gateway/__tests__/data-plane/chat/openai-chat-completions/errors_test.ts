import { test } from 'vitest';

import { inputErrorResult } from '../../../../src/data-plane/chat/openai-chat-completions/errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const apiErrorOf = (result: ReturnType<typeof inputErrorResult>): ApiErrorResult => result as ApiErrorResult;
const bodyOf = (result: ReturnType<typeof inputErrorResult>): unknown =>
  JSON.parse(new TextDecoder().decode(apiErrorOf(result).body));

test('inputErrorResult renders an OpenAI 400 invalid_request_error envelope with default `messages` param', () => {
  const result = inputErrorResult(
    { message: "Missing required field 'tool_call_id' on a 'tool' role message." },
  );
  const apiError = apiErrorOf(result);

  assertEquals(apiError.type, 'api-error');
  assertEquals(apiError.source, 'gateway');
  assertEquals(apiError.status, 400);
  assertEquals(bodyOf(result), {
    error: {
      message: "Missing required field 'tool_call_id' on a 'tool' role message.",
      type: 'invalid_request_error',
      param: 'messages',
      code: null,
    },
  });
});

test('inputErrorResult honors an explicit param from the translator', () => {
  const result = inputErrorResult(
    { message: 'content part not supported', param: 'messages[2].content[1]' },
  );

  assertEquals(bodyOf(result), {
    error: {
      message: 'content part not supported',
      type: 'invalid_request_error',
      param: 'messages[2].content[1]',
      code: null,
    },
  });
});
