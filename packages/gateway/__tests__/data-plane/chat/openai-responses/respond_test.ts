import { Hono } from 'hono';
import { beforeEach, expect, test } from 'vitest';

import { respondOpenAIResponses, respondOpenAIResponsesFailure } from '../../../../src/data-plane/chat/openai-responses/respond.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER } from '../../../../src/data-plane/chat/openai-responses/response-headers.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, parseOpenAIResponsesStream, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { eventResult, internalErrorResult, toInternalDebugError, type EventResultMetadata } from '@floway-dev/provider';
import { mockPerfTelemetryContext, testTelemetryModelIdentity } from '@floway-dev/test-utils';

beforeEach(() => { initRepo(new InMemoryRepo()); });

const internalFailure = () => {
  const cause = new TypeError('nested'); cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause }); failure.stack = 'Error: broken\n  at render';
  return failure;
};

const fields = { name: 'Error', stack: 'Error: broken\n  at render', cause: { name: 'TypeError', message: 'nested', stack: 'TypeError: nested\n  at nested' } };

const successfulFrames = async function* () {
  const response = {
    id: 'resp_test',
    object: 'response' as const,
    model: 'm',
    status: 'completed' as const,
    output: [],
    error: null,
    incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', response: { ...response, status: 'in_progress' } });
  yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.completed', response });
};

test.each([false, true])('Responses success declares historical reasoning accounting when stream=%s', async wantsStream => {
  const upstreamHeaders = new Headers({ 'x-reasoning-included': 'upstream-value', 'x-native': 'trace' });
  const app = new Hono().get('/', c => respondOpenAIResponses(
    c,
    eventResult(successfulFrames(), testTelemetryModelIdentity, { headers: upstreamHeaders }),
    wantsStream,
    mockChatGatewayCtx(),
    { model: 'm', input: [] },
  ));
  const response = await app.request('/');
  expect(response.status).toBe(200);
  expect(response.headers.get(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER)).toBe('true');
  expect(response.headers.get('x-native')).toBe('trace');
  await response.body?.cancel();
});

test('Responses HTTP internal errors keep status and native error fields while namespacing diagnostics', async () => {
  const response = respondOpenAIResponsesFailure(internalErrorResult(503, toInternalDebugError(internalFailure(), 'anthropicMessages')), mockChatGatewayCtx());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { type: 'internal_error', message: 'broken', provider_specific_fields: { ...fields, target_api: 'anthropicMessages' } } });
  const minimal = respondOpenAIResponsesFailure(internalErrorResult(502, { type: 'internal_error', name: 'Error', message: 'minimal' }), mockChatGatewayCtx());
  expect(await minimal.json()).toEqual({ error: { type: 'internal_error', message: 'minimal', provider_specific_fields: { name: 'Error' } } });
});

test('Responses SSE standalone error and failed response carry identical complete diagnostics', async () => {
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', response: { id: 'upstream', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } });
    throw internalFailure();
  };
  const app = new Hono().get('/', c => respondOpenAIResponses(c, eventResult(frames(), testTelemetryModelIdentity), true, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');
  expect(response.status).toBe(200);
  const wire = await response.text();
  const parsed = [];
  for await (const frame of parseOpenAIResponsesStream(new Response(wire).body!)) if (frame.type === 'event') parsed.push(frame.event);
  const error = parsed.find(event => event.type === 'error');
  const failed = parsed.find(event => event.type === 'response.failed');
  expect(error).toEqual({ type: 'error', sequence_number: 1, error: { code: 'internal_error', message: 'broken', provider_specific_fields: fields } });
  expect(failed).toBeDefined();
  if (failed?.type !== 'response.failed') throw new Error('Missing failed response');
  expect(failed.response.status).toBe('failed');
  expect(failed.response.error).toEqual((error as { error: unknown }).error);
  const terminalOnly = await collectOpenAIResponsesProtocolEventsToResult((async function* () { yield eventFrame(failed); })());
  expect(terminalOnly.error).toEqual(failed.response.error);
  await expect(collectOpenAIResponsesProtocolEventsToResult(parseOpenAIResponsesStream(new Response(wire).body!))).rejects.toMatchObject({ message: 'broken', cause: error });
});

test.each([false, true])('Responses HTTP consumes an upstream error followed by its failed resource when stream=%s', async wantsStream => {
  const item = { type: 'reasoning' as const, id: 'rs_complete', summary: [] };
  const error = { type: 'error' as const, sequence_number: 3, code: null, message: 'upstream failed', param: null, vendor: { detail: 'native' } };
  const failed = {
    id: 'resp_upstream', object: 'response' as const, model: 'm', status: 'failed' as const,
    output: [item], error: { code: 'vendor_failure', message: error.message }, incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', sequence_number: 0, response: { ...failed, status: 'in_progress', output: [], error: null } });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>(error);
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.failed', sequence_number: 4, response: failed });
  };
  const app = new Hono().get('/', c => respondOpenAIResponses(c, eventResult(frames(), testTelemetryModelIdentity), wantsStream, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');
  expect(response.status).toBe(wantsStream ? 200 : 502);
  if (!wantsStream) {
    const { sequence_number: _sequenceNumber, ...body } = error;
    expect(await response.json()).toEqual(body);
    return;
  }
  const events = [];
  for await (const frame of parseOpenAIResponsesStream(response.body!)) if (frame.type === 'event') events.push(frame.event);
  expect(events.map(event => event.type)).toEqual(['response.created', 'response.output_item.added', 'response.output_item.done', 'error', 'response.failed']);
  expect(events[3]).toEqual(error);
  expect(events.map(event => event.sequence_number)).toEqual([0, 1, 2, 3, 4]);
  const terminal = events.at(-1);
  if (terminal?.type !== 'response.failed') throw new Error('Missing failed response');
  const created = events[0];
  if (created.type !== 'response.created') throw new Error('Missing created response');
  expect(terminal.response.id).toBe(created.response.id);
  expect(terminal.response).toMatchObject({
    status: 'failed', output: [item], error: failed.error,
    usage: { ...failed.usage, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  });
  expect(terminal.response.id).not.toBe(failed.id);
});

test.each([
  { type: 'error' as const, sequence_number: 0, code: null, message: 'native failure', param: null, vendor: { detail: 'flat' } },
  { type: 'error' as const, sequence_number: 0, error: { code: 'vendor_failure', message: 'native failure', param: 'tools', vendor: { detail: 'nested' } }, trace: 'native-trace' },
])('Responses HTTP preserves a standalone upstream error event %j', async error => {
  for (const wantsStream of [false, true]) {
    const frames = async function* () { yield eventFrame<OpenAIResponsesStreamEventEx>(error); yield doneFrame(); };
    const app = new Hono().get('/', c => respondOpenAIResponses(c, eventResult(frames(), testTelemetryModelIdentity), wantsStream, mockChatGatewayCtx(), { model: 'm', input: [] }));
    const response = await app.request('/');
    expect(response.status).toBe(wantsStream ? 200 : 502);
    if (wantsStream) {
      const wire = await response.text();
      expect(wire.split('data: [DONE]').length - 1).toBe(1);
      const events = [];
      for await (const frame of parseOpenAIResponsesStream(new Response(wire).body!)) if (frame.type === 'event') events.push(frame.event);
      expect(events).toEqual([error]);
    } else {
      const { sequence_number: _sequenceNumber, ...body } = error;
      expect(await response.json()).toEqual(body);
    }
  }
});

test.each([
  { error: { type: 'error' as const, sequence_number: 0, error: { type: 'invalid_request_error', code: null, message: 'invalid tools', param: 'tools' } }, status: 400 },
  { error: { type: 'error' as const, sequence_number: 0, code: 'rate_limit_exceeded', message: 'slow down', param: null }, status: 429 },
  { error: { type: 'error' as const, sequence_number: 0, code: null, message: 'bad key', param: null, provider_specific_fields: { type: 'authentication_error' } }, status: 401 },
  { error: { type: 'error' as const, sequence_number: 0, code: 'server_error', message: 'failed', param: null }, status: 500 },
  { error: { type: 'error' as const, sequence_number: 0, code: 'vendor_failure', message: 'failed', param: null }, status: 502 },
] as const)('Responses non-streaming error classification selects HTTP $status', async ({ error, status }) => {
  const failed = { id: 'resp_failed', object: 'response', model: 'm', status: 'failed' as const, output: [], error: null, incomplete_details: null };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>(error);
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.failed', sequence_number: 1, response: failed });
  };
  const app = new Hono().get('/', c => respondOpenAIResponses(c, eventResult(frames(), testTelemetryModelIdentity), false, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');

  expect(response.status).toBe(status);
  const { sequence_number: _sequenceNumber, ...body } = error;
  expect(await response.json()).toEqual(body);
});

test.each([
  { type: 'error' as const, sequence_number: 3, code: null, param: 'tools', message: 'rate limited', vendor: { retryable: true } },
  { type: 'error' as const, sequence_number: 3, error: { code: null, param: null, message: 'rate limited', vendor: { retryable: true } }, trace: 'native-trace' },
])('Responses non-streaming failure drains the failed resource, preserves error fields, and records usage once: %j', async error => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const background: Promise<unknown>[] = [];
  const modelIdentity = { ...testTelemetryModelIdentity, upstream: 'continuation-upstream' };
  const telemetry = mockPerfTelemetryContext({ keyId: 'key_test', upstream: modelIdentity.upstream, runtimeLocation: 'TEST' });
  let resolveMetadata!: (metadata: EventResultMetadata) => void;
  const finalMetadata = new Promise<EventResultMetadata>(resolve => { resolveMetadata = resolve; });
  let readFailedResource = false;
  const item = { type: 'reasoning' as const, id: 'rs_complete', summary: [] };
  const failed = {
    id: 'resp_aggregate', object: 'response' as const, model: 'm', status: 'failed' as const,
    output: [item], error: null, incomplete_details: null,
    usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17 },
  };
  const frames = async function* () {
    try {
      yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', sequence_number: 0, response: { ...failed, status: 'in_progress', output: [] } });
      yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item });
      yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item });
      yield eventFrame<OpenAIResponsesStreamEventEx>(error);
      readFailedResource = true;
      yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.failed', sequence_number: 4, response: failed });
    } finally {
      resolveMetadata({ modelIdentity, performance: telemetry, billableUsage: { input: 10, cacheRead: 3, cacheWrite: 2, cacheWrite1h: 0, output: 2 } });
    }
  };
  const ctx = mockChatGatewayCtx({
    backgroundScheduler: promise => { background.push(promise); },
    attempt: { timing: { upstreamCallStartedAt: 0, firstOutputTokenAt: 1 }, telemetry },
  });
  const result = eventResult(frames(), testTelemetryModelIdentity, {
    performance: telemetry,
    finalMetadata,
  });
  const app = new Hono().get('/', c => respondOpenAIResponses(c, result, false, ctx, { model: 'm', input: [] }));
  const response = await app.request('/');
  expect(response.status).toBe(502);
  expect(readFailedResource).toBe(true);
  const { sequence_number: _sequenceNumber, ...body } = error;
  expect(await response.json()).toEqual(body);
  await Promise.all(background);
  const usage = await repo.usage.listAll();
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ requests: 1, upstream: modelIdentity.upstream });
  expect(tokenCountsFromUsage(usage[0])).toEqual({ input: 10, input_cache_read: 3, input_cache_write: 2, output: 2 });
  const performance = await repo.performance.listAll();
  expect(performance).toHaveLength(1);
  expect(performance[0]).toMatchObject({ requests: 1, errorsWithOutput: 1, errorsNoOutput: 0, ttftSamplesOk: 0, tpotSamples: 1 });
});

test('Responses collect failures preserve nested causes in the HTTP error namespace', async () => {
  const app = new Hono().get('/', c => respondOpenAIResponses(c, eventResult((async function* () { throw internalFailure(); })(), testTelemetryModelIdentity), false, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: { type: 'internal_error', message: 'broken', provider_specific_fields: fields } });
});

test('Responses native upstream HTTP error is forwarded without diagnostic restructuring', async () => {
  const raw = '{"error":{"message":"native","stack":"provider-owned","custom":true}}';
  const response = respondOpenAIResponsesFailure({ type: 'api-error', source: 'upstream', status: 429, headers: new Headers({ 'content-type': 'application/json', 'x-native': 'trace' }), body: new TextEncoder().encode(raw) }, mockChatGatewayCtx());
  expect(response.status).toBe(429);
  expect(response.headers.get('x-native')).toBe('trace');
  expect(response.headers.get(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER)).toBeNull();
  expect(await response.text()).toBe(raw);
});
