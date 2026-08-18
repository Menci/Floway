// The Anthropic error envelope, at the function that writes it.
//
// Key order is load-bearing: a client comparing this gateway's refusal against
// Anthropic-direct's compares bytes, so `type`, then `error`, then a top-level `request_id`.

import { test } from 'vitest';

import { renderMessagesError } from '../../../../src/data-plane/chat/anthropic-messages/errors.ts';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('renders an Anthropic invalid_request_error envelope with a top-level request_id', () => {
  const body = renderMessagesError(
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
  const raw = JSON.stringify(renderMessagesError(400, 'whatever'));
  assert(
    /^\{"type":"error","error":\{"type":"invalid_request_error","message":"whatever"\},"request_id":"req_[A-Za-z0-9]{24}"\}$/.test(raw),
    `body ${raw} must match Anthropic-direct byte shape`,
  );
});

test('names the condition each status carries in this protocol', () => {
  // The status a refusal was made with is what selects the type name, so the mapping is what
  // makes a gateway-made refusal read like the upstream's own.
  assertEquals((renderMessagesError(429, 'slow down').error as { type: string }).type, 'rate_limit_error');
  assertEquals((renderMessagesError(529, 'overloaded').error as { type: string }).type, 'overloaded_error');
  assertEquals((renderMessagesError(502, 'bad gateway').error as { type: string }).type, 'api_error');
});
