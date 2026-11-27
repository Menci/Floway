import { expect, test } from 'vitest';

import { openaiChatCompletionsInputError } from '../../../../src/data-plane/chat/openai-chat-completions/errors.ts';

test('translation input error has an OpenAI 400 invalid_request_error envelope that defaults param to messages', () => {
  const { http, outcome } = openaiChatCompletionsInputError(
    { message: "Missing required field 'tool_call_id' on a 'tool' role message." },
  );
  expect(http.status).toBe(400);
  expect(outcome).toMatchObject({ kind: 'error', source: 'local' });
  expect(outcome.error).toEqual({
    error: {
      message: "Missing required field 'tool_call_id' on a 'tool' role message.",
      type: 'invalid_request_error',
      param: 'messages',
      code: null,
    },
  });
  expect(openaiChatCompletionsInputError({ message: 'unsupported', param: 'messages[2].content[1]' }).outcome.error).toEqual({
    error: { message: 'unsupported', type: 'invalid_request_error', param: 'messages[2].content[1]', code: null },
  });
});
