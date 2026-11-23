import { test } from 'vitest';

import { openaiChatCompletionsInputError } from '../../../../src/data-plane/chat/openai-chat-completions/errors.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('translation errors render an OpenAI invalid_request_error envelope that defaults param to `messages`', () => {
  const result = openaiChatCompletionsInputError(
    { message: "Missing required field 'tool_call_id' on a 'tool' role message." },
  );
  assertEquals(result, {
    error: {
      message: "Missing required field 'tool_call_id' on a 'tool' role message.",
      type: 'invalid_request_error',
      param: 'messages',
      code: null,
    },
  });
  assertEquals(openaiChatCompletionsInputError({ message: 'unsupported', param: 'messages[2].content[1]' }), {
    error: { message: 'unsupported', type: 'invalid_request_error', param: 'messages[2].content[1]', code: null },
  });
});
