import { afterEach, expect, test, vi } from 'vitest';

import { chatUpstream, eventOutcome } from './fixture.ts';
import { observeAnthropicMessagesCall, observeGeminiGenerateContentCall, observeOpenAIChatCompletionsCall, observeOpenAIResponsesCall } from '../../../../src/data-plane/chat/shared/observe-usage.ts';
import type { CallPerformanceFacts, CallUsageFacts } from '../../../../src/data-plane/pipeline/call-metering.ts';
import type { CandidateRequest } from '../../../../src/data-plane/pipeline/failover.ts';
import { performanceRecord } from '../../../../src/data-plane/shared/telemetry/performance-record.ts';
import type { TransportFailure } from '@floway-dev/http';
import { compose, defineEnding, link, run, type Scope, snapshotError, type Stage } from '@floway-dev/pipeline';
import { type AnthropicMessagesStreamEventEx, createAnthropicMessagesUsage, toAnthropicMessagesUsageDelta } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { type OpenAIChatCompletionsStreamEvent, parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, ProtocolOutcome, ProviderBaseOutput, ProviderFrame } from '@floway-dev/provider';
import { mockPerfTelemetryContext } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

type OutcomeKey = `response.${ChatTargetApi}`;

const observe = <Key extends OutcomeKey, Event, Result = never>(
  stage: Stage, key: Key, answer: (scope: Scope) => ProtocolOutcome<Event, Result>,
  { signal, status = 200 }: { readonly signal?: AbortSignal; readonly status?: number } = {},
) => {
  type ProviderResponse = ProviderBaseOutput & Readonly<Partial<Record<OutcomeKey, ProtocolOutcome<Event, Result>>>>;
  type Space = CandidateRequest & ProviderBaseOutput & Readonly<Record<OutcomeKey, ProtocolOutcome<Event, Result>>> & CallUsageFacts & CallPerformanceFacts;
  const providerExit = ['response.http', 'response.modelKey', key] as const;
  const pipeline = compose<Space>()('test usage observation', {
    entry: ['route.candidate'],
    exit: [...providerExit, 'response.call.usage', 'response.call.performance'],
    stages: [stage],
    ending: defineEnding<CandidateRequest, ProviderResponse>({
      name: 'stubProvider',
      request: { needs: [] },
      return: { provides: providerExit },
      execute: async (_facts, scope) => ({
        'response.http': { status, statusText: '', body: null, headers: [], timing: { startedAt: 315, headersAt: 400 } },
        'response.modelKey': 'test-model-key',
        [key]: answer(scope),
      }),
    }),
  });
  link([pipeline]);
  return run(pipeline, { 'route.candidate': chatUpstream({ endpoints: { openaiResponses: {} } }).candidate }, {
    services: {}, finalizationTimeoutMs: 1_000, ...(signal === undefined ? {} : { signal }),
  });
};

const responsesKey = 'response.openaiResponses';
const completionsKey = 'response.openaiChatCompletions';
const responseFrame = (event: object) => eventFrame(event as OpenAIResponsesStreamEventEx);
const observeResponses = (frames: AsyncIterable<ProviderFrame<OpenAIResponsesStreamEventEx>>) =>
  observe(observeOpenAIResponsesCall, responsesKey, scope => eventOutcome(scope, frames));

const streamEvents = <Event, Result>(outcome: ProtocolOutcome<Event, Result>) => {
  if (outcome.kind !== 'stream') throw new Error(`Expected a stream outcome, got ${outcome.kind}`);
  return outcome.events;
};

test('measures output when the provider event becomes observable', async () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const ready = Promise.withResolvers<void>();
  const buffered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const opener = responseFrame({ type: 'response.output_item.added', output_index: 0, item: null });
  const delta = responseFrame({ type: 'response.output_text.delta', output_index: 0, item_id: 'message', delta: 'hello' });
  const handle = observeResponses((async function* () {
    yield opener;
    await ready.promise;
    buffered.resolve();
    await release.promise;
    yield delta;
    yield doneFrame();
  })());
  const response = await handle.result;
  const iterator = streamEvents(response[responsesKey])[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(opener);
  now = 500;
  const pending = iterator.next();
  ready.resolve();
  await buffered.promise;
  now = 15_000;
  release.resolve();
  expect((await pending).value).toEqual(delta);
  expect((await iterator.next()).value).toEqual(doneFrame());
  expect((await iterator.next()).done).toBe(true);
  expect(await response['response.call.usage'].promise).toMatchObject({ disposition: 'completed', usage: null });
  expect(await response['response.call.performance'].promise).toEqual({
    firstOutputAt: 15_000, streamEndedAt: 15_000, upstreamStartedAt: 315, outputTokens: 0, failed: false,
  });
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
  const handle = observe(observeOpenAIChatCompletionsCall, completionsKey, scope => eventOutcome(scope, parseOpenAIChatCompletionsStream(body)));
  const response = await handle.result;
  const iterator = streamEvents(response[completionsKey])[Symbol.asyncIterator]();
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
  expect(await response['response.call.usage'].promise).toMatchObject({ disposition: 'stream-error', usage: null });
  expect(await response['response.call.performance'].promise).toEqual({
    firstOutputAt: 5_000, streamEndedAt: 5_000, upstreamStartedAt: 315, outputTokens: 0, failed: true,
  });
  expect(await handle.done).toEqual({ ok: true });
});

test('cancelling an unread response settles a billable call without a performance sample', async () => {
  const abort = new AbortController();
  const iterate = vi.fn(async function* () { yield responseFrame({ type: 'response.created' }); });
  const handle = observe(observeOpenAIResponsesCall, responsesKey, scope => eventOutcome(scope, { [Symbol.asyncIterator]: iterate }), { signal: abort.signal });
  const response = await handle.result;
  abort.abort();
  expect(await response['response.call.usage'].promise).toMatchObject({
    disposition: 'cancelled', identity: { modelKey: 'test-model-key' }, usage: null,
  });
  expect(await response['response.call.performance'].promise).toBeNull();
  expect(iterate).not.toHaveBeenCalled();
  expect(await handle.done).toEqual({ ok: true });
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
  const handle = observeResponses((async function* () {
    for (const { ts, event } of timeline) {
      now = ts;
      yield responseFrame(event);
    }
    now = 5408;
  })());
  const response = await handle.result;
  expect(await Array.fromAsync(streamEvents(response[responsesKey]))).toHaveLength(timeline.length);
  expect(await response['response.call.usage'].promise).toMatchObject({
    disposition: 'completed', usage: { input: 76936, output: 202 },
  });
  const observed = await response['response.call.performance'].promise;
  expect(observed).toEqual({ firstOutputAt: 3596, streamEndedAt: 5408, upstreamStartedAt: 315, outputTokens: 202, failed: false });
  if (observed === null) throw new Error('Expected performance for a complete response');
  expect(performanceRecord({
    ...observed,
    dimensions: { ...mockPerfTelemetryContext(), hour: '2026-01-01T00:00:00.000Z' },
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
  const handle = observeResponses((async function* () {
    for (const { ts, event } of timeline) {
      now = ts;
      yield responseFrame(event);
    }
  })());
  const response = await handle.result;
  expect(await Array.fromAsync(streamEvents(response[responsesKey]))).toEqual(timeline.map(({ event }) => responseFrame(event)));
  expect(await response['response.call.usage'].promise).toMatchObject({ disposition: 'stream-error', usage: null });
  expect(await response['response.call.performance'].promise).toMatchObject({ firstOutputAt: withPriorCall ? 300 : 500, failed: true });
  expect(await handle.done).toEqual({ ok: true });
});

const completionsUsage = eventFrame<OpenAIChatCompletionsStreamEvent>({
  id: 'chunk', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});

test.each(['cancelled', 'released'] as const)('settles observed usage when a stream is %s before the terminal frame', async disposition => {
  const abort = new AbortController();
  const handle = observe(observeOpenAIChatCompletionsCall, completionsKey, scope => eventOutcome(scope, [completionsUsage, doneFrame()]), { signal: abort.signal });
  const response = await handle.result;
  const events = streamEvents(response[completionsKey]);
  const iterator = events[Symbol.asyncIterator]();
  expect(await iterator.next()).toMatchObject({ done: false, value: completionsUsage });
  if (disposition === 'cancelled') abort.abort();
  else {
    if (iterator.return === undefined) throw new Error('Expected a releasable stream iterator');
    await iterator.return();
  }
  expect(await response['response.call.usage'].promise).toMatchObject({ disposition, usage: { input: 4, output: 2 } });
  expect(await response['response.call.performance'].promise).toBeNull();
  expect(await handle.done).toEqual({ ok: true });
});

test('marks a mid-stream transport failure as failed and bills observed usage', async () => {
  const failure: TransportFailure = { type: 'transport-error', error: snapshotError(new Error('upstream body interrupted')) };
  const frames = [completionsUsage, failure];
  const handle = observe(observeOpenAIChatCompletionsCall, completionsKey, scope => eventOutcome<OpenAIChatCompletionsStreamEvent>(scope, frames));
  const response = await handle.result;
  expect(await Array.fromAsync(streamEvents(response[completionsKey]))).toEqual(frames);
  expect(await response['response.call.usage'].promise).toMatchObject({ disposition: 'stream-error', usage: { input: 4, output: 2 } });
  expect(await response['response.call.performance'].promise).toMatchObject({ firstOutputAt: null, outputTokens: 2, failed: true });
  expect(await handle.done).toEqual({ ok: true });
});

test.each([['upstream', 429], ['local', 400]] as const)('classifies a %s error reply', async (source, status) => {
  const outcome = { kind: 'error', source, error: 'the request failed' } as const;
  const handle = observe(observeOpenAIResponsesCall, responsesKey, () => outcome, { status });
  const response = await handle.result;
  expect(response[responsesKey]).toEqual(outcome);
  expect(await response['response.call.usage'].promise).toBeNull();
  expect(await response['response.call.performance'].promise).toEqual(source === 'local' ? null : {
    firstOutputAt: null, streamEndedAt: null, upstreamStartedAt: 315, outputTokens: 0, failed: true,
  });
  expect(await handle.done).toEqual({ ok: true });
});

test('combines Anthropic Messages usage and completes at message_stop', async () => {
  const frames = [
    eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'message_start',
      message: {
        type: 'message', id: 'msg_1', model: 'test-model', role: 'assistant', content: [],
        stop_reason: null, stop_details: null, stop_sequence: null, container: null, diagnostics: null, usage: createAnthropicMessagesUsage(3, 0),
      },
    }),
    eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'message_delta',
      delta: { container: null, stop_reason: 'end_turn', stop_details: null, stop_sequence: null },
      usage: toAnthropicMessagesUsageDelta(createAnthropicMessagesUsage(3, 5)),
    }),
    eventFrame<AnthropicMessagesStreamEventEx>({ type: 'message_stop' }),
  ];
  const key = 'response.anthropicMessages';
  const handle = observe(observeAnthropicMessagesCall, key, scope => eventOutcome(scope, frames));
  const response = await handle.result;
  expect(await Array.fromAsync(streamEvents(response[key]))).toEqual(frames);
  expect(await response['response.call.usage'].promise).toMatchObject({ disposition: 'completed', usage: { input: 3, output: 5 } });
  expect(await response['response.call.performance'].promise).toMatchObject({ outputTokens: 5, failed: false });
  expect(await handle.done).toEqual({ ok: true });
});

test('completes Gemini generateContent when all observed candidates finish', async () => {
  const frames = [
    eventFrame<GeminiGenerateContentStreamEvent>({ candidates: [{ index: 0 }, { index: 1, finishReason: 'STOP' }] }),
    eventFrame<GeminiGenerateContentStreamEvent>({
      candidates: [{ index: 0, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 3, totalTokenCount: 9 },
    }),
  ];
  const key = 'response.geminiGenerateContent';
  const handle = observe(observeGeminiGenerateContentCall, key, scope => eventOutcome(scope, frames));
  const response = await handle.result;
  expect(await Array.fromAsync(streamEvents(response[key]))).toEqual(frames);
  expect(await response['response.call.usage'].promise).toMatchObject({ disposition: 'completed', usage: { input: 6, output: 3 } });
  expect(await response['response.call.performance'].promise).toMatchObject({ outputTokens: 3, failed: false });
  expect(await handle.done).toEqual({ ok: true });
});
