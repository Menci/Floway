import { afterEach, expect, test, vi } from 'vitest';

import { chatUpstream } from './fixture.ts';
import { observeOpenAIChatCompletionsUsage, observeOpenAIResponsesUsage } from '../../../../src/data-plane/chat/shared/observe-usage.ts';
import type { CandidateRequest } from '../../../../src/data-plane/pipeline/failover.ts';
import type { UsageFacts } from '../../../../src/data-plane/pipeline/observe-usage.ts';
import { performanceRecord } from '../../../../src/data-plane/shared/telemetry/performance-record.ts';
import { compose, defineEnding, link, run, type Stage } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderStreamOutput } from '@floway-dev/provider';
import { mockPerfTelemetryContext } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

const observe = <Event>(stage: Stage, events: AsyncIterable<ProtocolFrame<Event>>, signal?: AbortSignal) => {
  type ProviderResponse = ProviderStreamOutput<Event>;
  const pipeline = compose<CandidateRequest, ProviderResponse & UsageFacts, {}>('test usage observation', {
    stages: [stage],
    ending: defineEnding<CandidateRequest, ProviderResponse>({
      name: 'stubProvider',
      request: { needs: [] },
      return: { provides: ['response.http', 'response.events', 'response.modelKey'] },
      execute: async (_facts, _into, env) => ({
        'response.http': { status: 200, statusText: '', body: null, headers: [], timing: { startedAt: 315, headersAt: 400 } },
        'response.modelKey': 'test-model-key',
        'response.events': env.createStream({ label: 'provider frames', iterate: () => events }),
      }),
    }),
  });
  link([pipeline]);
  return run(pipeline, { 'route.candidate': chatUpstream({ endpoints: { openaiResponses: {} } }).candidate }, {
    services: {}, finalizationTimeoutMs: 1_000, ...(signal === undefined ? {} : { signal }),
  });
};

const responseFrame = (event: object) => eventFrame(event as OpenAIResponsesStreamEventEx);

test('measures output when the provider event becomes observable', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const ready = Promise.withResolvers<void>();
  const buffered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const opener = responseFrame({ type: 'response.output_item.added', output_index: 0, item: null });
  const delta = responseFrame({ type: 'response.output_text.delta', output_index: 0, item_id: 'message', delta: 'hello' });
  const handle = observe(observeOpenAIResponsesUsage, (async function* () {
    yield opener;
    await ready.promise;
    buffered.resolve();
    await release.promise;
    yield delta;
  })());
  const response = await handle.result;
  const iterator = response['response.events']![Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(opener);
  now = 500;
  const pending = iterator.next();
  ready.resolve();
  await buffered.promise;
  now = 15_000;
  release.resolve();
  expect((await pending).value).toEqual(delta);
  expect((await iterator.next()).done).toBe(true);
  expect(await response['response.timing.firstOutputAt'].promise).toBe(15_000);
  expect(await handle.done).toEqual({ ok: true });
});

test.each([true, false])('parser backpressure delays observed output until consumption (same byte chunk: %s)', async sameChunk => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  const encoder = new TextEncoder();
  const encode = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  const role = encode({ role: 'assistant' });
  const text = encode({ content: 'hello' });
  const handle = observe(observeOpenAIChatCompletionsUsage, parseOpenAIChatCompletionsStream(body));
  const response = await handle.result;
  const iterator = response['response.events']![Symbol.asyncIterator]();
  if (!sameChunk) {
    upstream.enqueue(encoder.encode(role));
    await iterator.next();
  }
  now = 500;
  upstream.enqueue(encoder.encode(sameChunk ? role + text : text));
  now = 5_000;
  upstream.close();
  const frames = await Array.fromAsync({ [Symbol.asyncIterator]: () => iterator });
  expect(frames).toHaveLength(sameChunk ? 2 : 1);
  expect(await response['response.timing.firstOutputAt'].promise).toBe(5_000);
  expect(await handle.done).toEqual({ ok: true });
});

test('cancelling an unread response still settles billing and timing', async () => {
  const abort = new AbortController();
  const iterate = vi.fn(async function* () { yield responseFrame({ type: 'response.created' }); });
  const handle = observe(observeOpenAIResponsesUsage, { [Symbol.asyncIterator]: iterate }, abort.signal);
  const response = await handle.result;
  abort.abort();
  expect(await response['response.usage.billable'].promise).toMatchObject([
    { disposition: 'cancelled', identity: { modelKey: 'test-model-key' }, usage: null },
  ]);
  expect(await response['response.timing.firstOutputAt'].promise).toBeNull();
  expect(iterate).not.toHaveBeenCalled();
  await handle.done;
});

test('includes streamed reasoning in the generation interval', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timeline = [
    { ts: 3582, event: { type: 'response.created' } },
    { ts: 3596, event: { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1', summary: [] } } },
    { ts: 3598, event: { type: 'response.reasoning.delta', delta: 'Let me think' } },
    { ts: 4393, event: { type: 'response.reasoning.delta', delta: '.' } },
    {
      ts: 5392, event: {
        type: 'response.completed', response: {
          usage: { input_tokens: 76936, output_tokens: 202, total_tokens: 77138, output_tokens_details: { reasoning_tokens: 91 } },
        },
      },
    },
  ];
  const handle = observe(observeOpenAIResponsesUsage, (async function* () {
    for (const { ts, event } of timeline) {
      now = ts;
      yield responseFrame(event);
    }
    now = 5408;
  })());
  const response = await handle.result;
  expect(await Array.fromAsync(response['response.events']!)).toHaveLength(timeline.length);
  const firstOutputAt = await response['response.timing.firstOutputAt'].promise;
  const streamEndedAt = await response['response.timing.streamEndedAt'].promise;
  const [call] = await response['response.usage.billable'].promise;
  expect(firstOutputAt).toBe(3596);
  expect(call.usage?.output).toBe(202);
  expect(performanceRecord({
    dimensions: { ...mockPerfTelemetryContext(), hour: '2026-01-01T00:00:00.000Z' },
    firstOutputAt, streamEndedAt,
    upstreamStartedAt: response['response.http'].timing.startedAt,
    outputTokens: call.usage!.output, failed: false,
  })).toMatchObject({ kind: 'sample', sample: { ttftMs: 3281, tpotUs: 9015, success: true } });
  expect(await handle.done).toEqual({ ok: true });
});

test.each([true, false])('starts timing at runtime output only without a prior model item (prior call: %s)', async withPriorCall => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timeline = [
    { ts: 100, event: { type: 'response.created' } },
    { ts: 200, event: { type: 'response.output_item.added', item: { type: 'mcp_list_tools', tools: [] } } },
    ...(withPriorCall ? [{ ts: 300, event: { type: 'response.output_item.added', item: { type: 'shell_call' } } }] : []),
    { ts: 500, event: { type: 'response.output_item.done', item: { type: 'shell_call_output', output: [{ stdout: 'result', stderr: '' }] } } },
    { ts: 900, event: { type: 'response.output_text.delta', delta: 'answer' } },
  ];
  const handle = observe(observeOpenAIResponsesUsage, (async function* () {
    for (const { ts, event } of timeline) {
      now = ts;
      yield responseFrame(event);
    }
  })());
  const response = await handle.result;
  expect(await Array.fromAsync(response['response.events']!)).toEqual(timeline.map(({ event }) => responseFrame(event)));
  expect(await response['response.timing.firstOutputAt'].promise).toBe(withPriorCall ? 300 : 500);
  expect(await handle.done).toEqual({ ok: true });
});
