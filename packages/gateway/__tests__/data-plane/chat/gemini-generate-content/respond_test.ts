import { Hono } from 'hono';
import { beforeEach, expect, test } from 'vitest';

import { respondGeminiGenerateContent } from '../../../../src/data-plane/chat/gemini-generate-content/respond.ts';
import type { DumpAccumulator } from '../../../../src/dump/accumulator.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentErrorResponse, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ExecuteResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const encoder = new TextEncoder();

beforeEach(() => { initRepo(new InMemoryRepo()); });

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

test.each([
  {
    name: 'all candidates finished',
    next: { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } },
    outcome: 'completed',
  },
  {
    name: 'another candidate is still generating',
    next: { candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'partial' }] } }] },
    outcome: 'failed',
  },
] satisfies { name: string; next: GeminiGenerateContentStreamEvent; outcome: string }[])('Gemini SSE settles cancellation when $name', async ({ next, outcome }) => {
  const downstream = new AbortController();
  const waiting = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<string>();
  const dump = {
    frame: () => {},
    failed: () => settled.resolve('failed'),
    success: () => settled.resolve('completed'),
  } as unknown as DumpAccumulator;
  const events = (async function* () {
    yield eventFrame<GeminiGenerateContentStreamEvent>({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
    });
    yield eventFrame(next);
    if (!downstream.signal.aborted) {
      await new Promise<void>(resolve => {
        downstream.signal.addEventListener('abort', () => resolve(), { once: true });
        waiting.resolve();
      });
    }
  })();
  const app = new Hono().get('/', c => respondGeminiGenerateContent(c, {
    type: 'events', events, modelIdentity: testTelemetryModelIdentity,
  }, true, mockChatGatewayCtx({ dump, abortSignal: downstream.signal, downstreamAbortController: downstream })));
  const reader = (await app.request('/')).body!.getReader();
  try {
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"finishReason":"STOP"');
    await waiting.promise;
    expect(downstream.signal.aborted).toBe(false);
  } finally {
    await reader.cancel();
  }
  expect(downstream.signal.aborted).toBe(true);
  expect(await settled.promise).toBe(outcome);
});

test.each([false, true])('Gemini response terminates immediately on an error (stream=%s)', async stream => {
  const error = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } };
  const app = new Hono().get('/', c => respondGeminiGenerateContent(c, {
    type: 'events', events: (async function* () { yield eventFrame(error); throw new Error('Trailing frame pulled'); })(), modelIdentity: testTelemetryModelIdentity,
  }, stream, ctx()));
  const response = await app.request('/');
  const text = await response.text();
  assertEquals(response.status, stream ? 200 : 429);
  assertEquals(JSON.parse(text), error);
});

test.each([false, true])('Gemini response exposes EOF with an unfinished observed candidate (stream=%s)', async stream => {
  const app = new Hono().get('/', c => respondGeminiGenerateContent(c, {
    type: 'events', events: (async function* () {
      yield eventFrame({ candidates: [{ index: 0, content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
      yield eventFrame({ candidates: [{ index: 1, content: { parts: [{ text: 'unfinished' }] } }] });
    })(), modelIdentity: testTelemetryModelIdentity,
  }, stream, ctx()));
  const response = await app.request('/');
  const text = await response.text();
  assertEquals(response.status, stream ? 200 : 502);
  const errors = stream ? text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)) : [JSON.parse(text)];
  assertEquals(errors.length, 1);
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
    http: { status: 412, headers: new Headers({ 'content-type': 'application/json' }) },
    body: encoder.encode(JSON.stringify(upstreamBody)),
  });

  assertEquals(response.status, 412);
  assertEquals(await response.json(), upstreamBody);
});

test.each([false, true])('Gemini internal collect and SSE errors retain structured nested causes in RPC details (stream=%s)', async stream => {
  const cause = new TypeError('nested'); cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause }); failure.stack = 'Error: broken\n  at render';
  const app = new Hono().get('/', c => respondGeminiGenerateContent(c, {
    type: 'events', events: (async function* () { throw failure; })(), modelIdentity: testTelemetryModelIdentity,
  }, stream, ctx()));
  const response = await app.request('/');
  const text = await response.text();
  const body = JSON.parse(text);
  if (stream) assertEquals(text, JSON.stringify(body));
  assertEquals(response.status, stream ? 200 : 502);
  assertEquals(body.error, {
    code: stream ? 500 : 502, status: stream ? 'INTERNAL' : 'UNAVAILABLE', message: 'broken', details: [
      { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: ['Error: broken', '  at render'] },
      { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: 'internal_error', name: 'Error', cause: { name: 'TypeError', message: 'nested', stack: cause.stack } } },
    ],
  });
});
