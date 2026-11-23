import { test } from 'vitest';

import { anthropicMessagesInputErrorBody } from '../../../../src/data-plane/chat/anthropic-messages/errors.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('input errors render an Anthropic invalid_request_error envelope with top-level request_id', () => {
  const body = anthropicMessagesInputErrorBody(
    { message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model." },
  );

  assertEquals(body.type, 'error');
  assertEquals(body.error, {
    type: 'invalid_request_error',
    message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.",
  });
  assert(typeof body.request_id === 'string' && /^req_[A-Za-z0-9]{24}$/.test(body.request_id), `request_id ${String(body.request_id)} must match Anthropic-shape req_<24 opaque chars>`);
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('Anthropic input errors preserve $name exactly', ({ fields, expected }) => {
  const result = anthropicMessagesInputErrorBody({ message: 'invalid input', ...fields });
  assertEquals(result.error, {
    type: 'invalid_request_error',
    message: 'invalid input',
    ...(expected === undefined ? {} : { provider_specific_fields: expected }),
  });
});
