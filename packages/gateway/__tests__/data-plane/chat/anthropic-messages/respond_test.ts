import { Hono } from 'hono';
import { test } from 'vitest';

import { respondAnthropicMessages } from '../../../../src/data-plane/chat/anthropic-messages/respond.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { toInternalDebugError, internalErrorResult, eventResult } from '@floway-dev/provider';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

test.each([false, true])('anthropic-messages internal failures preserve transport shape and namespaced diagnostics (stream=%s)', async stream => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  const diagnostic = { name: 'Error', stack: failure.stack, cause: { name: 'TypeError', message: 'nested', stack: cause.stack }, target_api: 'anthropicMessages' };
  const app = new Hono().get('/', c => respondAnthropicMessages(c, stream
    ? eventResult((async function* () { throw failure; })(), testTelemetryModelIdentity)
    : internalErrorResult(503, toInternalDebugError(failure, 'anthropicMessages')), stream, mockChatGatewayCtx()));
  const response = await app.request('/');
  assertEquals(response.status, stream ? 200 : 503);
  const text = await response.text();
  const body = stream ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
  assertEquals(body, { type: 'error', error: { type: stream ? 'api_error' : 'internal_error', message: 'broken', provider_specific_fields: stream ? { name: diagnostic.name, stack: diagnostic.stack, cause: diagnostic.cause } : diagnostic } });
  if (stream) assertEquals(text.includes('event: error'), true);
});

test('anthropic-messages collecting a broken stream retains the nested error cause in an HTTP 502', async () => {
  const cause = new TypeError('nested'); cause.stack = 'TypeError: nested';
  const failure = new Error('broken', { cause }); failure.stack = 'Error: broken';
  const app = new Hono().get('/', c => respondAnthropicMessages(c, eventResult((async function* () { throw failure; })(), testTelemetryModelIdentity), false, mockChatGatewayCtx()));
  const response = await app.request('/');
  assertEquals(response.status, 502);
  assertEquals(await response.json(), { type: 'error', error: { type: 'internal_error', message: 'broken', provider_specific_fields: { name: 'Error', stack: failure.stack, cause: { name: 'TypeError', message: 'nested', stack: cause.stack } } } });
});
