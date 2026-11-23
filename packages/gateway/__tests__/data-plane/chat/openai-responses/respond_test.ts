import { expect, test } from 'vitest';

import { responsesFixture, responsesUpstream, wireEvents } from './fixture.ts';
import { openAIResponsesInternalErrorBody } from '../../../../src/data-plane/chat/openai-responses/encode.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER } from '../../../../src/data-plane/chat/openai-responses/response-headers.ts';
import { writeHttpResponse } from '../../../../src/data-plane/shared/http-writer.ts';
import { tokenCountsFromUsage } from '../../../../src/repo/usage-metrics.ts';
import { eventOutcome, httpReply, stubEgressPipeline } from '../shared/fixture.ts';
import { snapshotError } from '@floway-dev/pipeline';
import { doneFrame, eventFrame, parseSSEStream } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, parseOpenAIResponsesStream, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderFrame } from '@floway-dev/provider';

const render = async (frames: AsyncIterable<ProviderFrame<OpenAIResponsesStreamEventEx>>, stream: boolean, headers: ReadonlyArray<readonly [string, string]> = []) => {
  const candidate = responsesUpstream('responses', () => { throw new Error('Unexpected upstream fetch'); });
  const egress = stubEgressPipeline('openaiResponses', async (_facts, scope) => ({
    ...await httpReply(scope, new Response(null, { headers: headers.map(([name, value]) => [name, value]) })),
    outcome: eventOutcome(scope, frames),
  }));
  const mock = responsesFixture([candidate], undefined, { egress });
  return writeHttpResponse((await mock.request({ model: 'test-model', input: [], stream }).result)['response.http']);
};

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
  const response = await render(successfulFrames(), wantsStream, [...upstreamHeaders]);
  expect(response.status).toBe(200);
  expect(response.headers.get(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER)).toBe('true');
  expect(response.headers.get('x-native')).toBe('trace');
  await response.body?.cancel();
});

test('Responses internal errors keep native error fields and namespace diagnostics', () => {
  expect(openAIResponsesInternalErrorBody(internalFailure())).toEqual({
    error: { type: 'internal_error', message: 'broken', provider_specific_fields: fields },
  });
});

test('Responses SSE failures keep the announced resource, completed items, wire sequence and diagnostics', async () => {
  const item = { type: 'reasoning' as const, id: 'rs_complete', summary: [] };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', sequence_number: 4, response: { id: 'upstream', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.added', sequence_number: 5, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', sequence_number: 6, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.added', sequence_number: 7, output_index: 1, item: { ...item, id: 'rs_pending' } });
    yield { type: 'transport-error' as const, error: snapshotError(internalFailure()) };
  };
  const response = await render(frames(), true);
  expect(response.status).toBe(200);
  const wire = await response.text();
  const events: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of parseSSEStream(new Response(wire).body!)) {
    if (frame.data !== '[DONE]') events.push(JSON.parse(frame.data));
  }
  const [created, , completedItem, , error, failed] = events;
  expect(events.map(event => [event.type, event.sequence_number])).toEqual([
    ['response.created', 4], ['response.output_item.added', 5], ['response.output_item.done', 6], ['response.output_item.added', 7],
    ['error', 8], ['response.failed', 9],
  ]);
  expect(wire.endsWith('data: [DONE]\n\n')).toBe(true);
  const details = { code: 'internal_error', message: 'broken', provider_specific_fields: fields };
  expect(error).toEqual({ type: 'error', sequence_number: 8, code: details.code, message: details.message, param: null, error: details });
  if (created?.type !== 'response.created' || completedItem?.type !== 'response.output_item.done' || failed?.type !== 'response.failed') throw new Error('Missing response resource or completed item');
  expect(failed.response.id).toBe(created.response.id);
  expect(failed.response.output).toEqual([completedItem.item]);
  expect(failed.response.status).toBe('failed');
  expect(failed.response.error).toEqual(details);
  const terminalOnly = await collectOpenAIResponsesProtocolEventsToResult((async function* () { yield eventFrame(failed); })());
  expect(terminalOnly.error).toEqual(failed.response.error);
  await expect(collectOpenAIResponsesProtocolEventsToResult(parseOpenAIResponsesStream(new Response(wire).body!))).rejects.toMatchObject({ message: 'broken', cause: error });
});

test('Responses propagates an SSE encoding exception', async () => {
  const upstream = new Response([
    { type: 'response.created', sequence_number: 4, response: { id: 'upstream', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } },
    { type: 'vendor:event\nbad', sequence_number: 5 },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const source = parseOpenAIResponsesStream(upstream.body!);
  const response = await render(source, true);
  expect(response.status).toBe(200);
  await expect(response.text()).rejects.toThrow('SSE event name cannot contain CR or LF');
});

test('Responses finishes an announced resource when a native error is followed by EOF', async () => {
  const error = { type: 'error' as const, sequence_number: 4, code: 'rate_limit_exceeded', message: 'slow down', param: null, vendor: { retryable: true } };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', sequence_number: 3, response: { id: 'upstream', object: 'response', model: 'm', status: 'in_progress', output: [], error: null, incomplete_details: null } });
    yield eventFrame<OpenAIResponsesStreamEventEx>(error);
  };
  const wire = await (await render(frames(), true)).text();
  const events: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of parseSSEStream(new Response(wire).body!)) {
    if (frame.data !== '[DONE]') events.push(JSON.parse(frame.data));
  }
  expect(events.map(event => event.type)).toEqual(['response.created', 'error', 'response.failed']);
  const [created, native, terminal] = events;
  expect(native).toEqual(error);
  if (created.type !== 'response.created') throw new Error('Missing created resource');
  expect(terminal).toMatchObject({
    sequence_number: 5,
    response: { id: created.response.id, status: 'failed', error: { code: error.code, message: error.message, vendor: error.vendor } },
  });
  expect(wire.endsWith('data: [DONE]\n\n')).toBe(true);
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
  const response = await render(frames(), wantsStream);
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
    const response = await render(frames(), wantsStream);
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
  { error: { type: 'error' as const, sequence_number: 0, code: 'vendor_failure', message: 'failed', param: null }, status: 502 },
] as const)('Responses non-streaming error classification selects HTTP $status', async ({ error, status }) => {
  const failed = { id: 'resp_failed', object: 'response', model: 'm', status: 'failed' as const, output: [], error: null, incomplete_details: null };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>(error);
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.failed', sequence_number: 1, response: failed });
  };
  const response = await render(frames(), false);

  expect(response.status).toBe(status);
  const { sequence_number: _sequenceNumber, ...body } = error;
  expect(await response.json()).toEqual(body);
});

test('Responses non-streaming failure drains the failed resource, preserves error fields, and records usage once', async () => {
  const error = { type: 'error' as const, sequence_number: 3, code: null, param: 'tools', message: 'rate limited', vendor: { retryable: true } };
  let readFailedResource = false;
  const item = { type: 'reasoning' as const, id: 'rs_complete', summary: [] };
  const failed = {
    id: 'resp_aggregate', object: 'response' as const, model: 'm', status: 'failed' as const,
    output: [item], error: null, incomplete_details: null,
    usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 } },
  };
  const frames = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', sequence_number: 0, response: { ...failed, status: 'in_progress', output: [], usage: null } });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', sequence_number: 2, output_index: 0, item });
    yield eventFrame<OpenAIResponsesStreamEventEx>(error);
    readFailedResource = true;
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.failed', sequence_number: 4, response: failed });
  };
  const mock = responsesFixture([responsesUpstream('continuation-upstream', () => wireEvents(frames()))]);
  const handle = mock.request({ model: 'test-model', input: [] });
  const response = writeHttpResponse((await handle.result)['response.http']);
  expect(response.status).toBe(502);
  expect(readFailedResource).toBe(true);
  const { sequence_number: _sequenceNumber, ...body } = error;
  expect(await response.json()).toEqual(body);
  expect(await handle.done).toEqual({ ok: true });
  expect(mock.usage).toHaveLength(1);
  expect(mock.usage[0]).toMatchObject({ requests: 1, upstream: 'continuation-upstream' });
  expect(tokenCountsFromUsage(mock.usage[0])).toEqual({ input: 10, input_cache_read: 3, input_cache_write: 2, output: 2 });
  expect(mock.performance).toEqual([expect.objectContaining({ kind: 'sample', sample: expect.objectContaining({ success: false }) })]);
});

test('Responses native upstream HTTP error is forwarded without diagnostic restructuring', async () => {
  const raw = '{"error":{"message":"native","stack":"provider-owned","custom":true}}';
  const mock = responsesFixture([responsesUpstream('responses', () => new Response(raw, {
    status: 429, headers: { 'content-type': 'application/json', 'x-native': 'trace' },
  }))]);
  const handle = mock.request({ model: 'test-model', input: [] });
  const response = writeHttpResponse((await handle.result)['response.http']);
  await expect(handle.done).resolves.toEqual({ ok: true });
  expect(response.status).toBe(429);
  expect(response.headers.get('x-native')).toBe('trace');
  expect(response.headers.get(OPENAI_RESPONSES_REASONING_INCLUDED_HEADER)).toBeNull();
  expect(await response.text()).toBe(raw);
});
