import { test } from 'vitest';

import { inputErrorResult } from '../../../../src/data-plane/chat/openai-responses/errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const bodyOf = (result: ApiErrorResult): unknown =>
  JSON.parse(new TextDecoder().decode(result.body));

test('inputErrorResult renders an OpenAI 400 invalid_request_error envelope with default `input` param', () => {
  const result = inputErrorResult(
    { message: "Invalid input item type 'image_generation_call'." },
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
