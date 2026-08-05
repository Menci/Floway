import { Hono } from 'hono';
import { test } from 'vitest';

import { respondGemini } from '../../../../src/data-plane/chat/gemini/respond.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type { GeminiErrorResponse } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, InternalDebugError } from '@floway-dev/provider';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const encoder = new TextEncoder();

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  pricing: null,
};

const ctx = () => mockChatGatewayCtx();

const requestGeminiResponse = async (result: ExecuteResult<ProtocolFrame<GeminiErrorResponse>>): Promise<Response> => {
  const app = new Hono();
  app.get('/', async c => await respondGemini(c, result, false, ctx()));
  return await app.request('/');
};

test('respondGemini preserves non-stream Gemini error event HTTP code', async () => {
  const errorEvent: GeminiErrorResponse = {
    error: {
      code: 504,
      status: 'DEADLINE_EXCEEDED',
      message: 'timeout',
    },
  };

  const response = await requestGeminiResponse({
    type: 'events',
    events: (async function* () {
      yield eventFrame(errorEvent);
    })(),
    modelIdentity: testTelemetryModelIdentity,
  });

  assertEquals(response.status, 504);
  assertEquals(await response.json(), errorEvent);
});

test('respondGemini preserves upstream Google RPC Status body', async () => {
  const upstreamBody: GeminiErrorResponse = {
    error: {
      code: 412,
      status: 'FAILED_PRECONDITION',
      message: 'account is not ready',
    },
  };

  const response = await requestGeminiResponse({
    type: 'api-error',
    source: 'upstream',
    status: 400,
    headers: new Headers({
      'connection': 'keep-alive, x-upstream-hop',
      'content-length': '999',
      'content-type': 'text/plain',
      'set-cookie': 'upstream-session=secret',
      'transfer-encoding': 'chunked',
      'x-request-id': 'google-rpc-request',
      'x-upstream-hop': 'must-not-cross-hop',
    }),
    body: encoder.encode(JSON.stringify(upstreamBody)),
  });

  assertEquals(response.status, 412);
  assertEquals(response.headers.get('content-type'), 'application/json');
  assertEquals(response.headers.get('x-request-id'), 'google-rpc-request');
  assertEquals(response.headers.get('connection'), null);
  assertEquals(response.headers.get('content-length'), null);
  assertEquals(response.headers.get('set-cookie'), null);
  assertEquals(response.headers.get('transfer-encoding'), null);
  assertEquals(response.headers.get('x-upstream-hop'), null);
  assertEquals(await response.json(), upstreamBody);
});

test('respondGemini preserves valid non-Google error status and safe upstream headers', async () => {
  const response = await requestGeminiResponse({
    type: 'api-error',
    source: 'upstream',
    status: 418,
    headers: new Headers({
      'content-type': 'text/plain',
      'retry-after': '7',
      'set-cookie': 'upstream-session=secret',
      'x-request-id': 'non-google-request',
    }),
    body: encoder.encode('upstream rejected the request'),
  });

  assertEquals(response.status, 418);
  assertEquals(response.headers.get('content-type'), 'application/json');
  assertEquals(response.headers.get('retry-after'), '7');
  assertEquals(response.headers.get('x-request-id'), 'non-google-request');
  assertEquals(response.headers.get('set-cookie'), null);
  assertEquals(await response.json(), {
    error: {
      code: 418,
      message: 'upstream rejected the request',
      status: 'INTERNAL',
    },
  });
});

test('respondGemini internal errors include debug fields in Google RPC Status', async () => {
  const error: InternalDebugError = {
    type: 'internal_error',
    name: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at test',
    cause: { upstream: 'bad shape' },
    target_api: 'responses',
  };

  const response = await requestGeminiResponse({
    type: 'internal-error',
    status: 502,
    error,
  });
  const body = await response.json();

  assertEquals(response.status, 502);
  assertEquals(body.error.code, 502);
  assertEquals(body.error.status, 'UNAVAILABLE');
  assertEquals(body.error.message, 'boom');
  assertEquals(body.error.stack, error.stack);
  assertEquals(body.error.target_api, 'responses');
  assertExists(body.error.cause);
});
