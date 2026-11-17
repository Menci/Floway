import { afterEach, expect, test, vi } from 'vitest';

import { billableUsageFromOpenAIResponsesEvent } from '../../../../src/data-plane/chat/openai-responses/usage.ts';
import { providerStreamResultToExecuteResult } from '../../../../src/data-plane/chat/shared/provider-stream-result.ts';
import { recordPerformance } from '../../../../src/data-plane/shared/telemetry/performance.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { mockPerfTelemetryContext, stubModelCandidate } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

test('measures output when it becomes observable through the provider result', async () => {
  let now = 110;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let releaseOutput!: () => void;
  let releaseIdentity!: () => void;
  const outputReady = new Promise<void>(resolve => { releaseOutput = resolve; });
  const identityReady = new Promise<void>(resolve => { releaseIdentity = resolve; });
  let buffered = false;
  const opener: ProtocolFrame<unknown> = { type: 'event', event: { type: 'response.output_item.added', output_index: 0, item: null } };
  const delta: ProtocolFrame<unknown> = { type: 'event', event: { type: 'response.output_text.delta', output_index: 0, item_id: 'message', delta: 'hello' } };
  const done: ProtocolFrame<unknown> = { type: 'event', event: { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message' } } };
  const events = (async function* () {
    yield opener;
    await outputReady;
    buffered = true;
    await identityReady;
    yield delta;
    yield done;
  })();
  const ctx = mockGatewayCtx();
  const result = await providerStreamResultToExecuteResult(okStreamResult(events), stubModelCandidate(), 'openaiResponses', ctx, () => null);
  if (result.type !== 'events') throw new Error('Expected events');
  const iterator = result.events[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(opener);
  now = 500;
  const pendingOutput = iterator.next();
  releaseOutput();
  await vi.waitFor(() => { expect(buffered).toBe(true); });
  expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  now = 15000;
  releaseIdentity();
  expect((await pendingOutput).value).toEqual(delta);
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(15000);
  expect((await iterator.next()).value).toEqual(done);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  await result.finalMetadata;
});

test.each([true, false])('preserves parser consumption timing under downstream backpressure (same byte chunk: %s)', async sameChunk => {
  let now = 110;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  const encode = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  const role = encode({ role: 'assistant' });
  const text = encode({ content: 'hello' });
  const ctx = mockGatewayCtx();
  const result = await providerStreamResultToExecuteResult(okStreamResult(parseOpenAIChatCompletionsStream(body)), stubModelCandidate(), 'openaiChatCompletions', ctx, () => null);
  if (result.type !== 'events') throw new Error('Expected events');
  const iterator = result.events[Symbol.asyncIterator]();
  if (!sameChunk) {
    upstream.enqueue(new TextEncoder().encode(role));
    await iterator.next();
    expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  }
  now = 500;
  upstream.enqueue(new TextEncoder().encode(sameChunk ? role + text : text));
  expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  now = 5000;
  upstream.close();
  const collected = [];
  for await (const frame of { [Symbol.asyncIterator]: () => iterator }) collected.push(frame);
  expect(collected).toHaveLength(sameChunk ? 2 : 1);
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(5000);
  await result.finalMetadata;
});

test('does not pull the provider stream before consumption or read ahead between frames', async () => {
  const first: ProtocolFrame<unknown> = { type: 'event', event: { type: 'response.created' } };
  const second: ProtocolFrame<unknown> = { type: 'event', event: { type: 'response.output_text.delta', delta: 'hello' } };
  const source = iter([first, second])[Symbol.asyncIterator]();
  const next = vi.spyOn(source, 'next');
  const ctx = mockGatewayCtx();
  const result = await providerStreamResultToExecuteResult(okStreamResult({ [Symbol.asyncIterator]: () => source }), stubModelCandidate(), 'openaiResponses', ctx, () => null);
  if (result.type !== 'events') throw new Error('Expected events');
  expect(next).not.toHaveBeenCalled();
  const iterator = result.events[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toBe(first);
  expect(next).toHaveBeenCalledTimes(1);
  expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  expect((await iterator.next()).value).toBe(second);
  expect(next).toHaveBeenCalledTimes(2);
  expect(ctx.attempt.timing.firstOutputTokenAt).not.toBeNull();
  await iterator.return?.();
  await result.finalMetadata;
});

test('observes a terminal-only message after parsed discovery lifecycle without inventing earlier timing', async () => {
  let now = 120;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
  const ctx = mockGatewayCtx();
  const result = await providerStreamResultToExecuteResult(okStreamResult(parseOpenAIResponsesStream(body)), stubModelCandidate(), 'openaiResponses', ctx, () => null);
  if (result.type !== 'events') throw new Error('Expected events');
  const iterator = result.events[Symbol.asyncIterator]();
  const encode = (events: object[]) => new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const item = { type: 'mcp_list_tools', id: 'discovery', tools: [] };
  upstream.enqueue(encode([
    { type: 'response.output_item.added', sequence_number: 0, output_index: 0, item },
    { type: 'response.output_item.done', sequence_number: 1, output_index: 0, item },
  ]));
  await iterator.next();
  await iterator.next();
  expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  now = 500;
  upstream.enqueue(encode([{
    type: 'response.completed', sequence_number: 2, response: {
      id: 'response', object: 'response', status: 'completed', model: 'model', error: null, incomplete_details: null,
      output: [item, { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
    },
  }]));
  upstream.close();
  expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  const last = await iterator.next();
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500);
  expect(last.value?.type === 'event' && last.value.event.type).toBe('response.completed');
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  await result.finalMetadata;
});

const iter = <T>(items: readonly T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() { for (const item of items) yield item; },
});

const okStreamResult = <T>(events: AsyncIterable<ProtocolFrame<T>>): ProviderStreamResult<T> => ({
  ok: true,
  events,
  modelKey: 'test-model-key',
});

test('an abandoned stream still settles its metadata instead of hanging the caller', async () => {
  // Every streaming response resolves its cost through finalMetadata, and the
  // respond layer awaits it in a finally. A transport that walks away without
  // closing the generator would hang that await forever.
  const abort = new AbortController();
  const ctx = { ...mockGatewayCtx(), abortSignal: abort.signal };
  const frames: ProtocolFrame<unknown>[] = [{ type: 'event', event: { type: 'response.created' } }];

  const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'openaiResponses', ctx, () => null);
  expect(result.type).toBe('events');
  if (result.type !== 'events') return;

  // Never iterate the events; just abandon them.
  abort.abort();

  expect((await result.finalMetadata!).modelIdentity).toBeDefined();
});

test.each([true, false])('includes streamed reasoning in the generation interval (followed by tools: %s)', async withTools => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const pending: Promise<unknown>[] = [];
  const ctx = mockGatewayCtx({ backgroundScheduler: promise => { pending.push(promise); } });
  ctx.attempt.timing.upstreamCallStartedAt = 315;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const recordSample = vi.spyOn(repo.performance, 'recordSample');
  const timeline = [
    { ts: 3582, event: { type: 'response.created' } },
    { ts: 3596, event: { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1', summary: [] } } },
    { ts: 3598, event: { type: 'response.reasoning.delta', delta: 'Let me think' } },
    { ts: 4393, event: { type: 'response.reasoning.delta', delta: '.' } },
    ...(withTools ? [
      { ts: 4448, event: { type: 'response.output_item.added', item: { type: 'function_call', name: 'search' } } },
      { ts: 4448, event: { type: 'response.function_call_arguments.delta', delta: '{' } },
    ] : []),
    {
      ts: 5392, event: {
        type: 'response.completed', response: {
          usage: {
            input_tokens: 76936, output_tokens: 202, total_tokens: 77138,
            output_tokens_details: { reasoning_tokens: 91 },
          },
        },
      },
    },
  ];
  const events = (async function* (): AsyncGenerator<ProtocolFrame<unknown>> {
    for (const { ts, event } of timeline) {
      now = ts;
      yield { type: 'event', event };
    }
  })();
  const result = await providerStreamResultToExecuteResult(
    okStreamResult(events), stubModelCandidate(), 'openaiResponses', ctx,
    event => billableUsageFromOpenAIResponsesEvent(event as OpenAIResponsesStreamEventEx),
  );
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
  const stamps: (number | null)[] = [];
  for await (const _ of result.events) stamps.push(ctx.attempt.timing.firstOutputTokenAt);
  expect(new Set(stamps.filter(stamp => stamp !== null))).toEqual(new Set([3596]));
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(3596);
  const metadata = await result.finalMetadata!;
  expect(metadata.billableUsage?.output).toBe(202);
  recordPerformance(ctx, mockPerfTelemetryContext(), false, metadata.billableUsage!.output, 5408);
  await Promise.all(pending);
  expect(recordSample).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ttftMs: 3281, tpotUs: 9015, success: true }));
  expect(await repo.performance.listAll()).toEqual([expect.objectContaining({ ttftSamplesOk: 1, tpotSamples: 1, neutral: 0 })]);
});

const runtimeResult = { type: 'shell_call_output', output: [{ stdout: 'result', stderr: '' }] };

test.each([true, false])('warns on a first runtime result only when no earlier item started timing (prior call: %s)', async withPriorCall => {
  const ctx = mockGatewayCtx();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => { now += 50; });
  const timeline = [
    { ts: 100, event: { type: 'response.created' } },
    { ts: 200, event: { type: 'response.output_item.added', item: { type: 'mcp_list_tools', tools: [] } } },
    ...(withPriorCall ? [{ ts: 300, event: { type: 'response.output_item.added', item: { type: 'shell_call' } } }] : []),
    { ts: 500, event: { type: 'response.output_item.done', item: runtimeResult } },
    { ts: 900, event: { type: 'response.output_text.delta', delta: 'answer' } },
  ];
  const events = (async function* (): AsyncGenerator<ProtocolFrame<unknown>> {
    for (const { ts, event } of timeline) {
      now = ts;
      yield { type: 'event', event };
    }
  })();
  const result = await providerStreamResultToExecuteResult(okStreamResult(events), stubModelCandidate(), 'openaiResponses', ctx, () => null);
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
  const stamps: (number | null)[] = [];
  const forwarded: ProtocolFrame<unknown>[] = [];
  for await (const frame of result.events) {
    stamps.push(ctx.attempt.timing.firstOutputTokenAt);
    forwarded.push(frame);
  }
  expect(forwarded).toEqual(timeline.map(({ event }) => ({ type: 'event', event })));
  expect(new Set(stamps.filter(stamp => stamp !== null))).toEqual(new Set([withPriorCall ? 300 : 500]));
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(withPriorCall ? 300 : 500);
  if (withPriorCall) {
    expect(warn).not.toHaveBeenCalled();
  } else {
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Floway: first output timing started from runtime output without an earlier decode signal in this response',
      { outputType: runtimeResult.type, upstream: 'test-upstream', model: 'test-model', modelKey: 'test-model-key' },
    );
  }
});
