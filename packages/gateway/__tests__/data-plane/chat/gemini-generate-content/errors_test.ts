import { test } from 'vitest';

import { geminiInputErrorBody } from '../../../../src/data-plane/chat/gemini-generate-content/http-error.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('translation errors render a GenerateContent 400 INVALID_ARGUMENT envelope', () => {
  const result = geminiInputErrorBody({ message: '"inlineData" parts are not supported in user content.' });
  assertEquals(result.error, {
    code: 400,
    message: '"inlineData" parts are not supported in user content.',
    status: 'INVALID_ARGUMENT',
  });
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('translation errors preserve $name exactly', ({ fields, expected }) => {
  const result = geminiInputErrorBody({ message: 'invalid input', ...fields });
  // We preserve the translator's field and code in a Struct Any inside details.
  assertEquals(result.error, {
    code: 400,
    message: 'invalid input',
    status: 'INVALID_ARGUMENT',
    ...(expected === undefined ? {} : {
      details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: expected }],
    }),
  });
});
