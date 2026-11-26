import { test } from 'vitest';

import { inputErrorResult } from '../../../../src/data-plane/chat/openai-chat-completions/errors.ts';
import { assertEquals } from '@floway-dev/test-utils';
import { decodeResponseBody, type ApiErrorResult } from '@floway-dev/upstream';

const apiErrorOf = (result: ReturnType<typeof inputErrorResult>): ApiErrorResult => result as ApiErrorResult;
const bodyOf = (result: ReturnType<typeof inputErrorResult>): unknown =>
  JSON.parse(decodeResponseBody(apiErrorOf(result).body));

test('inputErrorResult renders an OpenAI 400 invalid_request_error envelope that defaults param to `messages`', () => {
  const result = inputErrorResult(
    { message: "Missing required field 'tool_call_id' on a 'tool' role message." },
  );
  const apiError = apiErrorOf(result);

  assertEquals(apiError.type, 'api-error');
  assertEquals(apiError.source, 'gateway');
  assertEquals(apiError.http.status, 400);
  assertEquals(bodyOf(result), {
    error: {
      message: "Missing required field 'tool_call_id' on a 'tool' role message.",
      type: 'invalid_request_error',
      param: 'messages',
      code: null,
    },
  });
  assertEquals(bodyOf(inputErrorResult({ message: 'unsupported', param: 'messages[2].content[1]' })), {
    error: { message: 'unsupported', type: 'invalid_request_error', param: 'messages[2].content[1]', code: null },
  });
});
