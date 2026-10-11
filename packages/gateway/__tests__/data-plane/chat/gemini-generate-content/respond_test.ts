import { Hono } from 'hono';
import { test } from 'vitest';

import { respondGeminiGenerateContent, geminiGenerateContentInternalRpcErrorResponse } from '../../../../src/data-plane/chat/gemini-generate-content/respond.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentErrorResponse } from '@floway-dev/protocols/gemini-generate-content';
import type { ExecuteResult, InternalDebugError } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const encoder = new TextEncoder();

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  pricing: null,
};

const ctx = () => mockChatGatewayCtx();

const requestGeminiGenerateContentResponse = async (result: ExecuteResult<ProtocolFrame<GeminiGenerateContentErrorResponse>>): Promise<Response> => {
  const app = new Hono();
  app.get('/', async c => await respondGeminiGenerateContent(c, result, false, ctx()));
  return await app.request('/');
};

test('respondGeminiGenerateContent preserves non-stream Gemini generateContent error event HTTP code', async () => {
  const errorEvent: GeminiGenerateContentErrorResponse = {
    error: {
      code: 504,
      status: 'DEADLINE_EXCEEDED',
      message: 'timeout',
    },
  };

  const response = await requestGeminiGenerateContentResponse({
    type: 'events',
    events: (async function* () {
      yield eventFrame(errorEvent);
    })(),
    modelIdentity: testTelemetryModelIdentity,
  });

  assertEquals(response.status, 504);
  assertEquals(await response.json(), errorEvent);
});

test('respondGeminiGenerateContent preserves upstream Google RPC Status body', async () => {
  const upstreamBody: GeminiGenerateContentErrorResponse = {
    error: {
      code: 412,
      status: 'FAILED_PRECONDITION',
      message: 'account is not ready',
    },
  };

  const response = await requestGeminiGenerateContentResponse({
    type: 'api-error',
    source: 'upstream',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: encoder.encode(JSON.stringify(upstreamBody)),
  });

  assertEquals(response.status, 412);
  assertEquals(await response.json(), upstreamBody);
});

test('respondGeminiGenerateContent internal errors include debug fields in Google RPC Status', async () => {
  const error: InternalDebugError = {
    type: 'internal_error',
    name: 'TypeError',
    message: 'boom',
    stack: 'TypeError: boom\n    at test',
    cause: { upstream: 'bad shape' },
    target_api: 'responses',
  };

  const response = await requestGeminiGenerateContentResponse({
    type: 'internal-error',
    status: 502,
    error,
  });
  const body = await response.json();

  assertEquals(response.status, 502);
  assertEquals(body.error.code, 502);
  assertEquals(body.error.status, 'UNAVAILABLE');
  assertEquals(body.error.message, 'boom');
  assertEquals(body.error, {
    code: 502, status: 'UNAVAILABLE', message: 'boom', details: [
      { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: ['TypeError: boom', '    at test'] },
      { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: 'internal_error', name: 'TypeError', cause: error.cause, target_api: 'responses' } },
    ],
  });
});

test.each([false, true])('Gemini internal collect and SSE errors retain structured nested causes in RPC details (stream=%s)', async stream => {
  const cause = new TypeError('nested'); cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause }); failure.stack = 'Error: broken\n  at render';
  const app = new Hono().get('/', c => respondGeminiGenerateContent(c, {
    type: 'events', events: (async function* () { throw failure; })(), modelIdentity: testTelemetryModelIdentity,
  }, stream, ctx()));
  const response = await app.request('/');
  const text = await response.text();
  const body = stream ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
  assertEquals(response.status, stream ? 200 : 502);
  assertEquals(body.error, {
    code: stream ? 500 : 502, status: stream ? 'INTERNAL' : 'UNAVAILABLE', message: 'broken', details: [
      { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: ['Error: broken', '  at render'] },
      { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: 'internal_error', name: 'Error', cause: { name: 'TypeError', message: 'nested', stack: cause.stack } } },
    ],
  });
});

test('Gemini shared countTokens error renderer uses RPC details without optional debug values', async () => {
  const failure = new Error('minimal'); failure.stack = undefined;
  const response = geminiGenerateContentInternalRpcErrorResponse(502, failure);
  assertEquals(response.status, 502);
  assertEquals(await response.json(), {
    error: {
      code: 502, status: 'UNAVAILABLE', message: 'minimal', details: [
        { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: 'internal_error', name: 'Error' } },
      ],
    },
  });
});
