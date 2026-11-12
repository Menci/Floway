import { test } from 'vitest';

import { inputErrorResult } from '../../../../src/data-plane/chat/anthropic-messages/errors.ts';
import { assert, assertEquals, mockPerfTelemetryContext } from '@floway-dev/test-utils';

const bodyOf = (result: ReturnType<typeof inputErrorResult>): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(result.body));

test('inputErrorResult renders an Anthropic 400 invalid_request_error envelope with top-level request_id', () => {
  const result = inputErrorResult(
    { message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model." },
  );

  assertEquals(result.type, 'api-error');
  assertEquals(result.source, 'gateway');
  assertEquals(result.status, 400);
  assertEquals(result.headers.get('content-type'), 'application/json');

  const body = bodyOf(result);
  assertEquals(body.type, 'error');
  assertEquals(body.error, {
    type: 'invalid_request_error',
    message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.",
  });
  assert(typeof body.request_id === 'string' && /^req_[A-Za-z0-9]{24}$/.test(body.request_id), `request_id ${String(body.request_id)} must match Anthropic-shape req_<24 opaque chars>`);
});

test('inputErrorResult preserves Anthropic key order: type, error, request_id', () => {
  const result = inputErrorResult({ message: 'whatever' });
  const raw = new TextDecoder().decode(result.body);
  // Key-order is load-bearing for byte-faithfulness with Anthropic-direct.
  assert(/^\{"type":"error","error":\{"type":"invalid_request_error","message":"whatever"\},"request_id":"req_[A-Za-z0-9]{24}"\}$/.test(raw), `body ${raw} must match Anthropic-direct byte shape`);
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'field only', fields: { param: 'messages[0].content' }, expected: { param: 'messages[0].content' } },
  { name: 'code only', fields: { code: 'unsupported_content' }, expected: { code: 'unsupported_content' } },
  { name: 'empty values', fields: { param: '', code: '' }, expected: { param: '', code: '' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('inputErrorResult preserves $name exactly', ({ fields, expected }) => {
  const result = inputErrorResult({ message: 'invalid input', ...fields });
  assertEquals(bodyOf(result).error, {
    type: 'invalid_request_error',
    message: 'invalid input',
    ...(expected === undefined ? {} : { provider_specific_fields: expected }),
  });
});

test('inputErrorResult retains the rejecting candidate performance context', () => {
  const performance = mockPerfTelemetryContext({ upstream: 'rejecting-candidate', model: 'resolved-model' });
  const result = inputErrorResult({ message: 'invalid input', param: 'model', code: 'missing_required_parameter' }, performance);
  assert(result.performance === performance);
});
