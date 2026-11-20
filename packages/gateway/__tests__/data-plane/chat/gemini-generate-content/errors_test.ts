import { test } from 'vitest';

import { mintGeminiGenerateContentInputFailure } from '../../../../src/data-plane/chat/gemini-generate-content/errors.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('mintGeminiGenerateContentInputFailure renders a GenerateContent 400 INVALID_ARGUMENT envelope', () => {
  const result = mintGeminiGenerateContentInputFailure({ message: '"inlineData" parts are not supported in user content.' });
  assertEquals(result.status, 400);
  assertEquals(result.body.error, {
    code: 400,
    message: '"inlineData" parts are not supported in user content.',
    status: 'INVALID_ARGUMENT',
  });
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'field only', fields: { param: 'contents[0].parts' }, expected: { param: 'contents[0].parts' } },
  { name: 'code only', fields: { code: 'unsupported_content' }, expected: { code: 'unsupported_content' } },
  { name: 'empty values', fields: { param: '', code: '' }, expected: { param: '', code: '' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('mintGeminiGenerateContentInputFailure preserves $name exactly', ({ fields, expected }) => {
  const result = mintGeminiGenerateContentInputFailure({ message: 'invalid input', ...fields });
  // We preserve the translator's field and code in a Struct Any inside details.
  assertEquals(result.body.error, {
    code: 400,
    message: 'invalid input',
    status: 'INVALID_ARGUMENT',
    ...(expected === undefined ? {} : {
      details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: expected }],
    }),
  });
});
