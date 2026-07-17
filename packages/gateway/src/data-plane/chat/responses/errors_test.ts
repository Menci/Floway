import { test } from 'vitest';

import { responsesInputErrorResult } from './errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const apiErrorOf = (result: ReturnType<typeof responsesInputErrorResult>): ApiErrorResult => result as ApiErrorResult;
const bodyOf = (result: ReturnType<typeof responsesInputErrorResult>): unknown =>
  JSON.parse(new TextDecoder().decode(apiErrorOf(result).body));

test('responsesInputErrorResult renders an OpenAI 400 invalid_request_error envelope with default `input` param', () => {
  const result = responsesInputErrorResult(
    new TranslatorInputError("Invalid input item type 'image_generation_call'."),
  );
  const apiError = apiErrorOf(result);

  assertEquals(apiError.type, 'api-error');
  assertEquals(apiError.source, 'gateway');
  assertEquals(apiError.status, 400);
  assertEquals(bodyOf(result), {
    error: {
      message: "Invalid input item type 'image_generation_call'.",
      type: 'invalid_request_error',
      param: 'input',
      code: null,
    },
  });
});

test('responsesInputErrorResult honors an explicit input param', () => {
  const result = responsesInputErrorResult(
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
