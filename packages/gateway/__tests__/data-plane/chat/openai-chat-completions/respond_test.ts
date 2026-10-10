import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { respondOpenAIChatCompletions } from '../../../../src/data-plane/chat/openai-chat-completions/respond.ts';
import type { DumpAccumulator } from '../../../../src/dump/accumulator.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError, internalErrorResult, eventResult } from '@floway-dev/provider';
import { assert, assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const recordingDump = () => {
  const frames: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
  return {
    frames,
    dump: {
      failed: () => {},
      success: () => {},
      frame: (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>) => { frames.push(frame); },
    } as unknown as DumpAccumulator,
  };
};

const chunk = (text: string): OpenAIChatCompletionsStreamEvent => ({
  id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm',
  choices: [{  index: 0, delta: { content: text }, finish_reason: null }],
});

const serve = async (dump: DumpAccumulator, frames: AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): Promise<string> => {
  const ctx = mockChatGatewayCtx({ wantsStream: true, dump });
  const app = new Hono().get('/', c =>
    respondOpenAIChatCompletions(c, eventResult(frames, testTelemetryModelIdentity), true, { include_usage: true }, ctx));
  return await (await app.request('/')).text();
};

test('the error frame the client is sent is recorded like every other frame', async () => {
  const { dump, frames } = recordingDump();
  const body = await serve(dump, (async function* () {
    yield eventFrame(chunk('hi'));
    throw new RangeError('cache token counts exceed inclusive input tokens: 479 - 13312 - 0');
  })());

  // What the client receives is unchanged by this.
  expect(body).toContain('event: error');
  expect(body).toContain('cache token counts exceed inclusive input tokens');
  expect(body).not.toContain('data: [DONE]');

  // And the recorded turn now ends on the same event rather than on the last
  // good chunk.
  assertEquals(frames.length, 2);
  const last = frames[1];
  assert(last.type === 'event', 'expected an event frame');
  const payload = last.event as unknown as { error?: { message?: string } };
  assertEquals(payload.error?.message, 'cache token counts exceed inclusive input tokens: 479 - 13312 - 0');
});

test('a stream that completes records only its own frames', async () => {
  const { dump, frames } = recordingDump();
  const body = await serve(dump, (async function* () {
    yield eventFrame(chunk('hi'));
    yield doneFrame();
  })());

  expect(body).toContain('data: [DONE]');
  assertEquals(frames.length, 2);
});

test('natural EOF forwards useful content without a missing-DONE error', async () => {
  const { dump, frames } = recordingDump();
  const body = await serve(dump, (async function* () { yield eventFrame(chunk('usable')); })());
  expect(body).toContain('usable');
  expect(body).not.toContain('event: error');
  expect(frames).toHaveLength(1);
});

test.each([false, true])('openai-chat-completions internal failures preserve transport shape and namespaced diagnostics (stream=%s)', async stream => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  const diagnostic = { name: 'Error', stack: failure.stack, cause: { name: 'TypeError', message: 'nested', stack: cause.stack }, target_api: 'anthropicMessages' };
  const app = new Hono().get('/', c => respondOpenAIChatCompletions(c, stream
    ? eventResult((async function* () { throw failure; })(), testTelemetryModelIdentity)
    : internalErrorResult(503, toInternalDebugError(failure, 'anthropicMessages')), stream, { include_usage: true }, mockChatGatewayCtx()));
  const response = await app.request('/');
  assertEquals(response.status, stream ? 200 : 503);
  const text = await response.text();
  const body = stream ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text);
  assertEquals(body, { error: { type: 'internal_error', message: 'broken', provider_specific_fields: stream ? { name: diagnostic.name, stack: diagnostic.stack, cause: diagnostic.cause } : diagnostic } });
  if (stream) assertEquals(text.includes('event: error'), true);
});

test('openai-chat-completions absent optional diagnostics stay absent and upstream errors preserve their payload', async () => {
  const app = new Hono().get('/', c => respondOpenAIChatCompletions(c, internalErrorResult(502, { type: 'internal_error', name: 'Error', message: 'minimal' }), false, { include_usage: true }, mockChatGatewayCtx()));
  assertEquals(await (await app.request('/')).json(), { error: { type: 'internal_error', message: 'minimal', provider_specific_fields: { name: 'Error' } } });
  const raw = '{"error":{"message":"native","stack":"provider-owned","custom":true}}';
  const native = new Hono().get('/', c => respondOpenAIChatCompletions(c, { type: 'api-error', source: 'upstream', status: 429, headers: new Headers({ 'content-type': 'application/json', 'x-native': 'trace' }), body: new TextEncoder().encode(raw) }, false, { include_usage: true }, mockChatGatewayCtx()));
  const response = await native.request('/');
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('x-native'), 'trace');
  assertEquals(await response.text(), raw);
});

test('openai-chat-completions collecting a broken stream retains the nested error cause in an HTTP 502', async () => {
  const cause = new TypeError('nested'); cause.stack = 'TypeError: nested';
  const failure = new Error('broken', { cause }); failure.stack = 'Error: broken';
  const app = new Hono().get('/', c => respondOpenAIChatCompletions(c, eventResult((async function* () { throw failure; })(), testTelemetryModelIdentity), false, { include_usage: true }, mockChatGatewayCtx()));
  const response = await app.request('/');
  assertEquals(response.status, 502);
  assertEquals(await response.json(), { error: { type: 'internal_error', message: 'broken', provider_specific_fields: { name: 'Error', stack: failure.stack, cause: { name: 'TypeError', message: 'nested', stack: cause.stack } } } });
});

test.each(['done', 'eof', 'error'] as const)('standard usage snapshots coalesce at %s without losing observed frames', async terminal => {
  const { dump, frames } = recordingDump();
  const body = await serve(dump, (async function* () {
    yield eventFrame({ ...chunk(''), choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } });
    yield eventFrame(chunk('answer'));
    yield eventFrame({ ...chunk(''), choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    if (terminal === 'done') yield doneFrame();
    if (terminal === 'error') yield eventFrame({ error: { message: 'upstream failure' } } as unknown as OpenAIChatCompletionsStreamEvent);
  })());
  const chunks = body.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  const usage = chunks.filter(chunk => chunk.choices?.length === 0);
  expect(usage).toHaveLength(terminal === 'error' ? 0 : 1);
  if (terminal !== 'error') expect(usage[0].usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  expect(frames.filter(frame => frame.type === 'event' && frame.event.choices?.length === 0)).toHaveLength(2);
});
