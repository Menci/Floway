import { expect, test } from 'vitest';

import { geminiGenerateContentInputError } from '../../../../src/data-plane/chat/gemini-generate-content/errors.ts';

test('translation input error has a Gemini Generate Content 400 INVALID_ARGUMENT envelope', () => {
  const { http, outcome } = geminiGenerateContentInputError({ message: '"inlineData" parts are not supported in user content.' });
  expect(http.status).toBe(400);
  expect(outcome).toEqual({
    kind: 'error', source: 'local',
    error: { error: { code: 400, message: '"inlineData" parts are not supported in user content.', status: 'INVALID_ARGUMENT' } },
  });
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('translation input error preserves $name exactly', ({ fields, expected }) => {
  const { outcome } = geminiGenerateContentInputError({ message: 'invalid input', ...fields });
  // We preserve the translator's field and code in a Struct Any inside details.
  expect(outcome.error).toEqual({
    error: {
      code: 400,
      message: 'invalid input',
      status: 'INVALID_ARGUMENT',
      ...(expected === undefined ? {} : {
        details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: expected }],
      }),
    },
  });
});
