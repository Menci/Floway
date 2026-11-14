// The Anthropic error envelope, at the function that writes it.
//
// Key order is load-bearing: a client comparing this gateway's refusal against
// Anthropic-direct's compares bytes, so `type`, then `error`, then a top-level `request_id`.

import { test } from 'vitest';

import { anthropicMessagesInputError, renderAnthropicMessagesError } from '../../../../src/data-plane/chat/anthropic-messages/errors.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('renders an Anthropic invalid_request_error envelope with a top-level request_id', () => {
  const body = renderAnthropicMessagesError(
    400,
    "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.",
  );

  assertEquals(body.type, 'error');
  assertEquals(body.error, {
    type: 'invalid_request_error',
    message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.",
  });
  assert(
    typeof body.request_id === 'string' && /^req_[A-Za-z0-9]{24}$/.test(body.request_id),
    `request_id ${String(body.request_id)} must match Anthropic-shape req_<24 opaque chars>`,
  );
});

test('preserves Anthropic key order: type, error, request_id', () => {
  const raw = JSON.stringify(renderAnthropicMessagesError(400, 'whatever'));
  assert(
    /^\{"type":"error","error":\{"type":"invalid_request_error","message":"whatever"\},"request_id":"req_[A-Za-z0-9]{24}"\}$/.test(raw),
    `body ${raw} must match Anthropic-direct byte shape`,
  );
});

test('names the condition each status carries in this protocol', () => {
  // The status a refusal was made with is what selects the type name, so the mapping is what
  // makes a gateway-made refusal read like the upstream's own.
  assertEquals((renderAnthropicMessagesError(429, 'slow down').error as { type: string }).type, 'rate_limit_error');
  assertEquals((renderAnthropicMessagesError(529, 'overloaded').error as { type: string }).type, 'overloaded_error');
  assertEquals((renderAnthropicMessagesError(502, 'bad gateway').error as { type: string }).type, 'api_error');
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'field only', fields: { param: 'messages[0].content' }, expected: { param: 'messages[0].content' } },
  { name: 'code only', fields: { code: 'unsupported_content' }, expected: { code: 'unsupported_content' } },
  { name: 'empty values', fields: { param: '', code: '' }, expected: { param: '', code: '' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('a refused input preserves $name exactly', ({ fields, expected }) => {
  assertEquals(anthropicMessagesInputError({ message: 'invalid input', ...fields }).error, {
    type: 'invalid_request_error',
    message: 'invalid input',
    ...(expected === undefined ? {} : { provider_specific_fields: expected }),
  });
});

test('a refused input names the field at fault in Anthropic key order', () => {
  const raw = JSON.stringify(anthropicMessagesInputError({ message: 'whatever', param: 'messages[0].content[1]', code: 'unsupported_content' }));
  assert(
    /^\{"type":"error","error":\{"type":"invalid_request_error","message":"whatever","provider_specific_fields":\{"param":"messages\[0\]\.content\[1\]","code":"unsupported_content"\}\},"request_id":"req_[A-Za-z0-9]{24}"\}$/.test(raw),
    `body ${raw} must match Anthropic-direct byte shape`,
  );
});
