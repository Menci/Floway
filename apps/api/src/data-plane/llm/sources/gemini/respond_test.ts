import { Hono } from 'hono';
import { test } from 'vitest';

import { respondGemini } from './respond.ts';
import { assertEquals, assertExists } from '../../../../test-assert.ts';
import type { RequestContext } from '../../interceptors.ts';
import type { InternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type { GeminiErrorResponse } from '@floway-dev/protocols/gemini';

const encoder = new TextEncoder();

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};
const request = (): RequestContext => ({
  requestStartedAt: performance.now(),
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },  runtimeLocation: 'test',
  clientStream: false,
});

const requestGeminiResponse = async (result: ExecuteResult<ProtocolFrame<GeminiErrorResponse>>): Promise<Response> => {
  const app = new Hono();
  app.get('/', async c => (await respondGemini(c, result, false, request(), undefined)).response);
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
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: encoder.encode(JSON.stringify(upstreamBody)),
  });

  assertEquals(response.status, 412);
  assertEquals(await response.json(), upstreamBody);
});

test('respondGemini internal errors include debug fields in Google RPC Status', async () => {
  const error: InternalDebugError = {
    type: 'internal_error',
    name: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at test',
    cause: { upstream: 'bad shape' },
    source_api: 'messages',
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
  assertEquals(body.error.source_api, 'messages');
  assertEquals(body.error.target_api, 'responses');
  assertExists(body.error.cause);
});
