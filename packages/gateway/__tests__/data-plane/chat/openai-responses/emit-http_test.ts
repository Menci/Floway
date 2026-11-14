import { Hono } from 'hono';
import type { Context } from 'hono';
import { beforeEach, expect, test } from 'vitest';

import type { ChatAnswer } from '../../../../src/data-plane/chat/facts.ts';
import { emitOpenAIResponses } from '../../../../src/data-plane/chat/openai-responses/emit.ts';
import { meterUsage } from '../../../../src/data-plane/chat/openai-responses/meter.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER } from '../../../../src/data-plane/chat/openai-responses/response-headers.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { isFrames, prologueFor, serveThrough } from '../../../../src/data-plane/pipeline/serve.ts';
import { writeSettlement } from '../../../../src/data-plane/pipeline/settlement.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { compose, defineStage, move } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, parseOpenAIResponsesStream, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { internalDebugErrorFields, toInternalDebugError, type InternalDebugError, type TelemetryModelIdentity } from '@floway-dev/provider';
import { mockPerfTelemetryContext, testTelemetryModelIdentity } from '@floway-dev/test-utils';

beforeEach(() => { initRepo(new InMemoryRepo()); });

type ScriptedAnswer = { answer: ChatAnswer; identity: TelemetryModelIdentity; headers: Headers };
const streamAnswer = (frames: AsyncIterable<ReturnType<typeof eventFrame<OpenAIResponsesStreamEventEx>> | ReturnType<typeof doneFrame>>, identity: TelemetryModelIdentity, options: { headers?: Headers } = {}): ScriptedAnswer => ({ answer: { kind: 'stream', frames }, identity, headers: options.headers ?? new Headers() });
const internalAnswer = (status: number, error: InternalDebugError): ScriptedAnswer => ({ answer: { status, message: error.message, envelope: { error: { type: error.type, message: error.message, provider_specific_fields: internalDebugErrorFields(error) } } }, identity: testTelemetryModelIdentity, headers: new Headers() });
const renderResponse = async (c: Context, scripted: ScriptedAnswer, wantsStream: boolean, gateway: ChatGatewayCtx, payload: CanonicalOpenAIResponsesPayload): Promise<Response> => {
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'scriptedUpstream',
    return: { provides: ['response.chat.openaiResponses', 'response.usage.billable', 'response.http.headers', 'response.http.status'] },
    execute: async facts => move({
      ...facts,
      'response.chat.openaiResponses': scripted.answer,
      'response.usage.billable': [{ identity: scripted.identity, quantities: {} }],
      'response.http.headers': [...scripted.headers],
      'response.http.status': 'status' in scripted.answer ? scripted.answer.status : 200,
    }),
  });
  const pipeline = compose<Record<string, unknown>, Record<string, unknown>>('emitHttpUnderTest', [
    writeSettlement(facts => Number(facts['response.http.status']) >= 400, 'response.chat.openaiResponses.streamedUsage', false),
    emitOpenAIResponses('sse'), meterUsage('response.chat.openaiResponses.streamedUsage'), ending,
  ]);
  const prologue = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] });
  return await serveThrough(c, prologue, pipeline as never, move({ 'request.chat.openaiResponses': payload, 'ingress.chat.openaiResponses.wantsStream': wantsStream }), facts => {
    const body = (facts as Record<string, unknown>)['response.chat.openaiResponses.rendered'];
    return isFrames(body) ? { frames: body } : { body: JSON.stringify(body), contentType: 'application/json' };
  });
};
const renderFailure = async (scripted: ScriptedAnswer, gateway: ChatGatewayCtx): Promise<Response> =>
  await new Hono().get('/', c => renderResponse(c, scripted, false, gateway, { model: 'm', input: [] })).request('/');

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

test.each([false, true])('OpenAI Responses success declares historical reasoning accounting when stream=%s', async wantsStream => {
  const upstreamHeaders = new Headers({ 'x-reasoning-included': 'upstream-value', 'x-native': 'trace' });
  const app = new Hono().get('/', c => renderResponse(
    c,
    streamAnswer(successfulFrames(), testTelemetryModelIdentity, { headers: upstreamHeaders }),
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

test('OpenAI Responses HTTP internal errors keep status and native error fields while namespacing diagnostics', async () => {
  const response = await renderFailure(internalAnswer(503, toInternalDebugError(internalFailure(), 'anthropicMessages')), mockChatGatewayCtx());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { type: 'internal_error', message: 'broken', provider_specific_fields: { ...fields, target_api: 'anthropicMessages' } } });
  const minimal = await renderFailure(internalAnswer(502, { type: 'internal_error', name: 'Error', message: 'minimal' }), mockChatGatewayCtx());
  expect(await minimal.json()).toEqual({ error: { type: 'internal_error', message: 'minimal', provider_specific_fields: { name: 'Error' } } });
});

test('OpenAI Responses SSE standalone error and failed response carry identical complete diagnostics', async () => {
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', response: { id: 'upstream', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } });
    throw internalFailure();
  };
  const app = new Hono().get('/', c => renderResponse(c, streamAnswer(frames(), testTelemetryModelIdentity), true, mockChatGatewayCtx(), { model: 'm', input: [] }));
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

test.each([false, true])('OpenAI Responses HTTP consumes an upstream error followed by its failed resource when stream=%s', async wantsStream => {
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
  const app = new Hono().get('/', c => renderResponse(c, streamAnswer(frames(), testTelemetryModelIdentity), wantsStream, mockChatGatewayCtx(), { model: 'm', input: [] }));
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
])('OpenAI Responses HTTP preserves a standalone upstream error event %j', async error => {
  for (const wantsStream of [false, true]) {
    const frames = async function* () { yield eventFrame<OpenAIResponsesStreamEventEx>(error); yield doneFrame(); };
    const app = new Hono().get('/', c => renderResponse(c, streamAnswer(frames(), testTelemetryModelIdentity), wantsStream, mockChatGatewayCtx(), { model: 'm', input: [] }));
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
] as const)('OpenAI Responses non-streaming error classification selects HTTP $status', async ({ error, status }) => {
  const failed = { id: 'resp_failed', object: 'response', model: 'm', status: 'failed' as const, output: [], error: null, incomplete_details: null };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>(error);
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.failed', sequence_number: 1, response: failed });
  };
  const app = new Hono().get('/', c => renderResponse(c, streamAnswer(frames(), testTelemetryModelIdentity), false, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');

  expect(response.status).toBe(status);
  const { sequence_number: _sequenceNumber, ...body } = error;
  expect(await response.json()).toEqual(body);
});

test.each([
  { type: 'error' as const, sequence_number: 3, code: null, param: 'tools', message: 'rate limited', vendor: { retryable: true } },
  { type: 'error' as const, sequence_number: 3, error: { code: null, param: null, message: 'rate limited', vendor: { retryable: true } }, trace: 'native-trace' },
])('OpenAI Responses non-streaming failure drains the failed resource, preserves error fields, and records usage once: %j', async error => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const background: Promise<unknown>[] = [];
  const modelIdentity = { ...testTelemetryModelIdentity, upstream: 'continuation-upstream' };
  const telemetry = mockPerfTelemetryContext({ keyId: 'key_test', upstream: modelIdentity.upstream, runtimeLocation: 'TEST' });
  let readFailedResource = false;
  const item = { type: 'reasoning' as const, id: 'rs_complete', summary: [] };
  const failed = {
    id: 'resp_aggregate', object: 'response' as const, model: 'm', status: 'failed' as const,
    output: [item], error: null, incomplete_details: null,
    usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 } },
  };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', sequence_number: 0, response: { ...failed, status: 'in_progress', output: [] } });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>(error);
    readFailedResource = true;
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.failed', sequence_number: 4, response: failed });
  };
  const ctx = mockChatGatewayCtx({
    backgroundScheduler: promise => { background.push(promise); },
    attempt: { timing: { upstreamCallStartedAt: 0, firstOutputTokenAt: 1 }, telemetry },
  });
  const result = streamAnswer(frames(), modelIdentity);
  const app = new Hono().get('/', c => renderResponse(c, result, false, ctx, { model: 'm', input: [] }));
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

test('OpenAI Responses collect failures preserve nested causes in the HTTP error namespace', async () => {
  const app = new Hono().get('/', c => renderResponse(c, streamAnswer((async function* () { throw internalFailure(); })(), testTelemetryModelIdentity), false, mockChatGatewayCtx(), { model: 'm', input: [] }));
  const response = await app.request('/');
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: { type: 'internal_error', message: 'broken', provider_specific_fields: fields } });
});

test('OpenAI Responses native upstream HTTP error is forwarded without diagnostic restructuring', async () => {
  const raw = '{"error":{"message":"native","stack":"provider-owned","custom":true}}';
  const response = await renderFailure({ answer: { status: 429, message: 'native', body: JSON.parse(raw) }, identity: testTelemetryModelIdentity, headers: new Headers({ 'content-type': 'application/json', 'x-native': 'trace' }) }, mockChatGatewayCtx());
  expect(response.status).toBe(429);
  expect(response.headers.get('x-native')).toBe('trace');
  expect(response.headers.get(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER)).toBeNull();
  expect(await response.text()).toBe(raw);
});
