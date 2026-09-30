import { expect, test } from 'vitest';

import type { ProviderChatResponse, ProviderChatServices } from '../../src/pipeline.ts';
import { decodeProviderResponse } from '../../src/stages/decode-response.ts';
import { observeProviderCall } from '../../src/stages/observe-call.ts';
import { http, type HttpRequestFacts } from '@floway-dev/http/pipeline';
import { compose, defineStage, getFailureFacts, move, run, setRelease } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

type Entry = HttpRequestFacts & { 'request.provider.modelKey': string };
const entry = (): Entry => move({
  'request.provider.modelKey': 'actual-wire-model',
  'request.http.callId': 1,
  'request.http.url': 'https://upstream.example/chat/completions',
  'request.http.method': 'POST',
  'request.http.headers': [],
  'request.http.body': { model: 'actual-wire-model', stream: true, messages: [] },
  'request.http.encoding': 'json',
});
const pipeline = compose<Entry, ProviderChatResponse<'openaiChatCompletions'>>('provider.chat', [decodeProviderResponse('openaiChatCompletions'), observeProviderCall, http]);
const services = (response: () => Promise<Response>, record: ProviderChatServices['recordProtocolFrames'] = frames => frames): ProviderChatServices => ({
  httpCall: () => ({ fetcher: response, signal: undefined, waitUntil: () => {}, wrapUpstreamCall: call => call() }),
  recordProtocolFrames: record,
});

test('stream decoding records its protocol stream and shares the single owned HTTP body', async () => {
  let streams = 0;
  const executed = await run(pipeline, entry(), services(async () => new Response('data: {"id":"reply","choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }), frames => { streams++; return frames; }));
  const output = executed.facts['response.provider.output'];
  expect(output).not.toBeNull();
  if (output === null || !('kind' in output) || output.kind !== 'stream') throw new Error('Expected decoded stream');
  const frames: ProtocolFrame<unknown>[] = [];
  for await (const frame of output.frames) frames.push(frame);
  expect(frames.map(frame => frame.type)).toEqual(['event', 'done']);
  expect(streams).toBe(1);
  expect(executed.facts['response.provider.called']).toBe(true);
  expect(executed.facts['response.provider.modelKey']).toBe('actual-wire-model');
  const exchange = executed.facts['response.http.exchange'];
  if (exchange.type !== 'response' || exchange.body === null) throw new Error('Expected HTTP body');
  expect(executed.facts['response.http.body']).toBe(exchange.body);
  setRelease(exchange.body, async () => {});
  await executed.drain();
});

test('a successful non-SSE reply is a protocol failure value with its complete parsed payload', async () => {
  const body = { error: { message: 'x'.repeat(4096) } };
  const executed = await run(pipeline, entry(), services(async () => Response.json(body)));
  const output = executed.facts['response.provider.output'];
  expect(output).toMatchObject({ status: 502, body });
  expect(executed.facts['response.provider.called']).toBe(true);
  expect(executed.facts['response.http.exchange']).toMatchObject({ type: 'response', status: 200 });
  await executed.drain();
});

test('actual HTTP replies remain failure facts when a higher decoder stage throws', async () => {
  const error = new TypeError('programming error', { cause: new Error('original cause') });
  const fault = defineStage<object, object, ProviderChatResponse<'openaiChatCompletions'>, ProviderChatResponse<'openaiChatCompletions'>>({
    name: 'faultAfterReply',
    through: { request: { needs: [], consumes: [], provides: [] }, response: { needs: [], consumes: [], provides: [] } },
    execute: async (facts, next) => { await next(move({ ...facts })); throw error; },
  });
  try {
    await run(compose<Entry, ProviderChatResponse<'openaiChatCompletions'>>('provider.fault', [fault, decodeProviderResponse('openaiChatCompletions'), observeProviderCall, http]), entry(), services(async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })));
    throw new Error('Expected stage failure');
  } catch (caught) {
    expect(caught).toBe(error);
    expect(getFailureFacts(caught)).toMatchObject({ 'response.provider.called': true, 'response.provider.modelKey': 'actual-wire-model', 'response.provider.previousCalls': [] });
  }
});
