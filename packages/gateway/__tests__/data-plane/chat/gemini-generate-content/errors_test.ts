import { test } from 'vitest';

import { translatorInputErrorResult } from '../../../../src/data-plane/chat/gemini-generate-content/errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const bodyOf = (result: ReturnType<typeof translatorInputErrorResult>): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode((result as ApiErrorResult).body));

test('translatorInputErrorResult renders a GenerateContent 400 INVALID_ARGUMENT envelope', () => {
  const result = translatorInputErrorResult(new TranslatorInputError('"inlineData" parts are not supported in user content.'));
  const apiError = result as ApiErrorResult;

  assertEquals(apiError.status, 400);
  assertEquals(apiError.source, 'gateway');
  assertEquals(bodyOf(result).error, {
    code: 400,
    message: '"inlineData" parts are not supported in user content.',
    status: 'INVALID_ARGUMENT',
  });
});

test('translatorInputErrorResult keeps the field and code the translator named', () => {
  // GenerateContent states non-standard failure data as a Struct inside its
  // details list, so that is where a named request field travels.
  const result = translatorInputErrorResult(
    new TranslatorInputError("Missing required parameter: 'model'.", { param: 'model', code: 'missing_required_parameter' }),
  );

  assertEquals((bodyOf(result).error as Record<string, unknown>).details, [{
    '@type': 'type.googleapis.com/google.protobuf.Struct',
    value: { param: 'model', code: 'missing_required_parameter' },
  }]);
});
