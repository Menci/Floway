import { test } from 'vitest';

import { translatorInputErrorResult } from '../../../../src/data-plane/chat/messages/errors.ts';
import type { ApiErrorResult } from '@floway-dev/provider';
import { assert, assertEquals } from '@floway-dev/test-utils';
import { TranslatorInputError } from '@floway-dev/translate';

const apiErrorOf = (result: ReturnType<typeof translatorInputErrorResult>): ApiErrorResult => result as ApiErrorResult;
const bodyOf = (result: ReturnType<typeof translatorInputErrorResult>): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(apiErrorOf(result).body));

test('translatorInputErrorResult renders an Anthropic 400 invalid_request_error envelope with top-level request_id', () => {
  const result = translatorInputErrorResult(
    new TranslatorInputError("Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model."),
  );
  const apiError = apiErrorOf(result);

  assertEquals(apiError.type, 'api-error');
  assertEquals(apiError.source, 'gateway');
  assertEquals(apiError.status, 400);
  assertEquals(apiError.headers.get('content-type'), 'application/json');

  const body = bodyOf(result);
  assertEquals(body.type, 'error');
  assertEquals(body.error, {
    type: 'invalid_request_error',
    message: "Invalid 'image_url' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.",
  });
  assert(typeof body.request_id === 'string' && /^req_[A-Za-z0-9]{24}$/.test(body.request_id), `request_id ${String(body.request_id)} must match Anthropic-shape req_<24-base62>`);
});

test('translatorInputErrorResult preserves Anthropic key order: type, error, request_id', () => {
  const result = translatorInputErrorResult(new TranslatorInputError('whatever'));
  const raw = new TextDecoder().decode(apiErrorOf(result).body);
  // Key-order is load-bearing for byte-faithfulness with Anthropic-direct.
  assert(/^\{"type":"error","error":\{"type":"invalid_request_error","message":"whatever"\},"request_id":"req_[A-Za-z0-9]{24}"\}$/.test(raw), `body ${raw} must match Anthropic-direct byte shape`);
});
