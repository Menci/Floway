import { test } from 'vitest';

import { translatorInputErrorResult } from '../../../../src/data-plane/chat/chat-completions/errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const apiErrorOf = (result: ReturnType<typeof translatorInputErrorResult>): ApiErrorResult => result as ApiErrorResult;
const bodyOf = (result: ReturnType<typeof translatorInputErrorResult>): unknown =>
  JSON.parse(new TextDecoder().decode(apiErrorOf(result).body));

test('translatorInputErrorResult renders an OpenAI 400 invalid_request_error envelope with default `messages` param', () => {
  const result = translatorInputErrorResult(
    new TranslatorInputError("Missing required field 'tool_call_id' on a 'tool' role message."),
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

test('translatorInputErrorResult honors an explicit param from the translator', () => {
  const result = translatorInputErrorResult(
    new TranslatorInputError('content part not supported', { param: 'messages[2].content[1]' }),
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
