import { test } from 'vitest';

import { inputErrorResult } from '../../../../src/data-plane/chat/gemini-generate-content/errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const bodyOf = (result: ReturnType<typeof inputErrorResult>): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode((result as ApiErrorResult).body));

test('inputErrorResult renders a GenerateContent 400 INVALID_ARGUMENT envelope', () => {
  const result = inputErrorResult({ message: '"inlineData" parts are not supported in user content.' });
  const apiError = result as ApiErrorResult;

  assertEquals(apiError.status, 400);
  assertEquals(apiError.source, 'gateway');
  assertEquals(bodyOf(result).error, {
    code: 400,
    message: '"inlineData" parts are not supported in user content.',
    status: 'INVALID_ARGUMENT',
  });
});

test('inputErrorResult keeps the field and code the translator named', () => {
  // GenerateContent states non-standard failure data as a Struct inside its
  // details list, so that is where a named request field travels.
  const result = inputErrorResult(
    { message: "Missing required parameter: 'model'.", param: 'model', code: 'missing_required_parameter' },
  );

  assertEquals((bodyOf(result).error as Record<string, unknown>).details, [{
    '@type': 'type.googleapis.com/google.protobuf.Struct',
    value: { param: 'model', code: 'missing_required_parameter' },
  }]);
});
