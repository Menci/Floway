import { test } from 'vitest';

import { inputErrorResult } from '../../../../src/data-plane/chat/gemini-generate-content/errors.ts';
import { decodeResponseBody } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const bodyOf = (result: ReturnType<typeof inputErrorResult>): Record<string, unknown> =>
  JSON.parse(decodeResponseBody(result.body));

test('inputErrorResult renders a GenerateContent 400 INVALID_ARGUMENT envelope', () => {
  const result = inputErrorResult({ message: '"inlineData" parts are not supported in user content.' });
  assertEquals(result.type, 'api-error');
  assertEquals(result.source, 'gateway');
  assertEquals(result.http.status, 400);
  assertEquals(result.http.headers.get('content-type'), 'application/json');
  assertEquals(bodyOf(result).error, {
    code: 400,
    message: '"inlineData" parts are not supported in user content.',
    status: 'INVALID_ARGUMENT',
  });
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('inputErrorResult preserves $name exactly', ({ fields, expected }) => {
  const result = inputErrorResult({ message: 'invalid input', ...fields });
  // We preserve the translator's field and code in a Struct Any inside details.
  assertEquals(bodyOf(result).error, {
    code: 400,
    message: 'invalid input',
    status: 'INVALID_ARGUMENT',
    ...(expected === undefined ? {} : {
      details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: expected }],
    }),
  });
});
