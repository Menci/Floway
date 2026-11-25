import { test } from 'vitest';

import { geminiGenerateContentInputError } from '../../../../src/data-plane/chat/gemini-generate-content/pipeline/parse-request.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('Gemini translation input errors use the 400 INVALID_ARGUMENT envelope', () => {
  const result = geminiGenerateContentInputError({ type: 'input-error', message: '"inlineData" parts are not supported in user content.' });
  assertEquals(result.error, {
    code: 400,
    message: '"inlineData" parts are not supported in user content.',
    status: 'INVALID_ARGUMENT',
  });
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('Gemini translation input errors preserve $name', ({ fields, expected }) => {
  const result = geminiGenerateContentInputError({ type: 'input-error', message: 'invalid input', ...fields });
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
