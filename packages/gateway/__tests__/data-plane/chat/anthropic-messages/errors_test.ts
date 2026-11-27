import { expect, test } from 'vitest';

import { anthropicMessagesInputError } from '../../../../src/data-plane/chat/anthropic-messages/errors.ts';

test('translation input error has an Anthropic 400 invalid_request_error envelope with top-level request_id', () => {
  const { http, outcome } = anthropicMessagesInputError(
    { message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model." },
  );

  expect(http.status).toBe(400);
  expect(outcome).toEqual({
    kind: 'error', source: 'local',
    error: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.",
      },
      request_id: expect.stringMatching(/^req_[A-Za-z0-9]{24}$/),
    },
  });
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('translation input error preserves $name exactly', ({ fields, expected }) => {
  const { outcome } = anthropicMessagesInputError({ message: 'invalid input', ...fields });
  expect(outcome.error).toEqual({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'invalid input',
      ...(expected === undefined ? {} : { provider_specific_fields: expected }),
    },
    request_id: expect.any(String),
  });
});
