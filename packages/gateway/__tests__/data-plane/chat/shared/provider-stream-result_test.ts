import { afterEach, describe, expect, test, vi } from 'vitest';

import { createAnthropicMessagesBillableUsageReader } from '../../../../src/data-plane/chat/anthropic-messages/usage.ts';
import { billableUsageFromOpenAIResponsesEvent } from '../../../../src/data-plane/chat/openai-responses/usage.ts';
import { providerStreamResultToExecuteResult } from '../../../../src/data-plane/chat/shared/provider-stream-result.ts';
import { recordPerformance } from '../../../../src/data-plane/shared/telemetry/performance.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
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
  releaseOutput();
  await vi.waitFor(() => { expect(buffered).toBe(true); });
  expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  now = 15000;
  releaseIdentity();
  await vi.waitFor(() => { expect(ctx.attempt.timing.firstOutputTokenAt).toBe(15000); });
  expect((await iterator.next()).value).toEqual(delta);
  expect((await iterator.next()).value).toEqual(done);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  await result.finalMetadata;
});

test.each([true, false])('timestamps parsed upstream output while downstream is stalled (same byte chunk: %s)', async sameChunk => {
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
  await vi.waitFor(() => { expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500); });
  now = 5000;
  upstream.close();
  const collected = [];
  for await (const frame of { [Symbol.asyncIterator]: () => iterator }) collected.push(frame);
  expect(collected).toHaveLength(sameChunk ? 2 : 1);
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500);
  await result.finalMetadata;
});

test('return before consumption cancels a pending parser read and settles metadata', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const controller = new AbortController();
  const ctx = mockGatewayCtx({ abortSignal: controller.signal, downstreamAbortController: controller });
  const result = await providerStreamResultToExecuteResult(okStreamResult(parseOpenAIChatCompletionsStream(body, { signal: controller.signal })), stubModelCandidate(), 'openaiChatCompletions', ctx, () => null);
  if (result.type !== 'events') throw new Error('Expected events');
  await result.events[Symbol.asyncIterator]().return?.();
  expect(cancel).toHaveBeenCalledOnce();
  expect(controller.signal.aborted).toBe(true);
  expect((await result.finalMetadata)?.modelIdentity).toBeDefined();
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
  await vi.waitFor(() => { expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500); });
  const last = await iterator.next();
  expect(last.value?.type === 'event' && last.value.event.type).toBe('response.completed');
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  await result.finalMetadata;
});

test('a saturated prefix keeps the shared attempt timing unavailable across continuations', async () => {
  const ctx = mockGatewayCtx();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const frames: ProtocolFrame<unknown>[] = Array.from({ length: 256 }, () => ({ type: 'event', event: { type: 'response.created' } }));
  frames.push({ type: 'event', event: { type: 'response.output_item.added', item: { type: 'message' } } });
  const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'openaiResponses', ctx, () => null);
  await vi.waitFor(() => { expect(ctx.attempt.outputObservationUnavailable).toBe(true); });
  expect(await drainEvents(result)).toEqual(frames);
  const continuation = await providerStreamResultToExecuteResult(okStreamResult(iter(frames.slice(-1))), stubModelCandidate(), 'openaiResponses', ctx, () => null);
  await drainEvents(continuation);
  expect(ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  expect(warn).toHaveBeenCalledOnce();
});

const iter = <T>(items: readonly T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() { for (const item of items) yield item; },
});

const okStreamResult = <T>(events: AsyncIterable<ProtocolFrame<T>>): ProviderStreamResult<T> => ({
  ok: true,
  events,
  modelKey: 'test-model-key',
});

const drainEvents = async <T>(result: Awaited<ReturnType<typeof providerStreamResultToExecuteResult<T>>>): Promise<ProtocolFrame<T>[]> => {
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
  const collected: ProtocolFrame<T>[] = [];
  for await (const frame of result.events) collected.push(frame);
  return collected;
};

describe('providerStreamResultToExecuteResult (first-output-token stamping)', () => {
  test('stamps firstOutputTokenAt on the first generated-token frame (messages thinking_delta)', async () => {
    const ctx = mockGatewayCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { type: 'message_start' } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } } },
    ];
    const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'anthropicMessages', ctx, () => null);
    const collected = await drainEvents(result);
    expect(collected).toEqual(frames);
    expect(ctx.attempt.timing.firstOutputTokenAt).not.toBe(null);
  });

  test('leaves firstOutputTokenAt null when only envelope frames appear', async () => {
    const ctx = mockGatewayCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { type: 'response.created' } },
      { type: 'event', event: { type: 'response.in_progress' } },
    ];
    const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'openaiResponses', ctx, () => null);
    await drainEvents(result);
    expect(ctx.attempt.timing.firstOutputTokenAt).toBe(null);
  });

  test('stamps at most once even for many output-content frames', async () => {
    const ctx = mockGatewayCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { choices: [{ delta: { content: 'a' } }] } },
      { type: 'event', event: { choices: [{ delta: { content: 'b' } }] } },
      { type: 'event', event: { choices: [{ delta: { content: 'c' } }] } },
    ];
    const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'openaiChatCompletions', ctx, () => null);
    if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
    const stampsAfterEachFrame: (number | null)[] = [];
    for await (const _ of result.events) stampsAfterEachFrame.push(ctx.attempt.timing.firstOutputTokenAt);
    expect(stampsAfterEachFrame[0]).not.toBe(null);
    // The subsequent frames must observe the exact same stamp — the stamping
    // hook never overwrites once firstOutputTokenAt has been set.
    expect(stampsAfterEachFrame[1]).toBe(stampsAfterEachFrame[0]);
    expect(stampsAfterEachFrame[2]).toBe(stampsAfterEachFrame[0]);
  });
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

test('waits for generated tool content after Chat Completions identity frames', async () => {
  const ctx = mockGatewayCtx();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timeline = [
    { ts: 100, delta: { role: 'assistant' } },
    { ts: 200, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function' }] } },
    { ts: 300, delta: { tool_calls: [{ index: 0, function: { name: 'search' } }] } },
    { ts: 400, delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } },
  ];
  const events = (async function* (): AsyncGenerator<ProtocolFrame<unknown>> {
    for (const { ts, delta } of timeline) {
      now = ts;
      yield { type: 'event', event: { choices: [{ delta }] } };
    }
  })();
  const result = await providerStreamResultToExecuteResult(okStreamResult(events), stubModelCandidate(), 'openaiChatCompletions', ctx, () => null);
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
  const stamps: (number | null)[] = [];
  for await (const _ of result.events) stamps.push(ctx.attempt.timing.firstOutputTokenAt);
  expect(new Set(stamps.filter(stamp => stamp !== null))).toEqual(new Set([300]));
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(300);
});

test.each([
  { item: { type: 'message', content: [] }, completed: { type: 'message', content: [{ type: 'output_text', text: 'hello' }] } },
  { item: { type: 'future_model_output', id: 'item_1' }, completed: { type: 'future_model_output', id: 'item_1' } },
])('uses known and unknown output item announcements as decode signals: %j', async ({ item, completed }) => {
  const ctx = mockGatewayCtx();
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const timeline = [
    { ts: 100, event: { type: 'response.created' } },
    { ts: 200, event: { type: 'response.output_item.added', item } },
    { ts: 600, event: { type: 'response.output_item.done', item: completed } },
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
  for await (const _ of result.events) stamps.push(ctx.attempt.timing.firstOutputTokenAt);
  expect(new Set(stamps.filter(stamp => stamp !== null))).toEqual(new Set([200]));
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(200);
});

test('counts private reasoning as decode time while ignoring pre-inference tool discovery', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const pending: Promise<unknown>[] = [];
  const ctx = mockGatewayCtx({ backgroundScheduler: promise => { pending.push(promise); } });
  ctx.attempt.timing.upstreamCallStartedAt = 100;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const recordSample = vi.spyOn(repo.performance, 'recordSample');
  const timeline = [
    { ts: 110, event: { type: 'response.created' } },
    { ts: 120, event: { type: 'response.output_item.added', item: { type: 'mcp_list_tools', tools: [] } } },
    { ts: 150, event: { type: 'response.output_item.done', item: { type: 'mcp_list_tools', tools: [{ name: 'search' }] } } },
    { ts: 500, event: { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1', summary: [] } } },
    { ts: 15000, event: { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'private reasoning' } } },
    { ts: 15001, event: { type: 'response.output_item.added', item: { type: 'message', content: [] } } },
    { ts: 15002, event: { type: 'response.output_text.delta', delta: 'answer' } },
    {
      ts: 16000, event: {
        type: 'response.completed', response: {
          usage: { input_tokens: 10, output_tokens: 202, total_tokens: 212, output_tokens_details: { reasoning_tokens: 190 } },
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
  expect(new Set(stamps.filter(stamp => stamp !== null))).toEqual(new Set([500]));
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500);
  const metadata = await result.finalMetadata!;
  expect(metadata.billableUsage?.output).toBe(202);
  recordPerformance(ctx, mockPerfTelemetryContext(), false, metadata.billableUsage!.output, 16000);
  await Promise.all(pending);
  expect(recordSample).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ttftMs: 400, tpotUs: 77114, success: true }));
});

describe.each([
  { callType: 'tool_search_call', item: { type: 'tool_search_output', tools: [] } },
  { callType: 'program', item: { type: 'program_output', result: 'result' } },
  { callType: 'multi_agent_call', item: { type: 'multi_agent_call_output', output: [{ type: 'output_text', text: 'result' }] } },
  { callType: 'shell_call', item: { type: 'shell_call_output', output: [{ stdout: 'result', stderr: '' }] } },
])('runtime result timing for $item.type', ({ callType, item }) => {
  describe.each(['response.output_item.added', 'response.output_item.done'])('first result event: %s', resultEventType => {
    test.each([true, false])('warns only when no earlier item started timing (prior call: %s)', async withPriorCall => {
      const ctx = mockGatewayCtx();
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { now += 50; });
      const timeline = [
        { ts: 100, event: { type: 'response.created' } },
        { ts: 200, event: { type: 'response.output_item.added', item: { type: 'mcp_list_tools', tools: [] } } },
        ...(withPriorCall ? [{ ts: 300, event: { type: 'response.output_item.added', item: { type: callType } } }] : []),
        { ts: 500, event: { type: resultEventType, item } },
        { ts: 700, event: { type: 'response.output_item.done', item } },
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
          { outputType: item.type, upstream: 'test-upstream', model: 'test-model', modelKey: 'test-model-key' },
        );
      }
    });
  });
});

test('counts omitted Anthropic thinking from its surviving block announcement', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const pending: Promise<unknown>[] = [];
  const ctx = mockGatewayCtx({ backgroundScheduler: promise => { pending.push(promise); } });
  ctx.attempt.timing.upstreamCallStartedAt = 100;
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const recordSample = vi.spyOn(repo.performance, 'recordSample');
  const timeline = [
    { ts: 110, event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
    { ts: 500, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } },
    { ts: 15000, event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private reasoning' } } },
    { ts: 15001, event: { type: 'content_block_stop', index: 0 } },
    { ts: 15002, event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } } },
    { ts: 15003, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } } },
    { ts: 16000, event: { type: 'message_delta', usage: { output_tokens: 202 } } },
    { ts: 16000, event: { type: 'message_stop' } },
  ];
  const events = (async function* (): AsyncGenerator<ProtocolFrame<unknown>> {
    for (const { ts, event } of timeline) { now = ts; yield { type: 'event', event }; }
  })();
  const readUsage = createAnthropicMessagesBillableUsageReader();
  const result = await providerStreamResultToExecuteResult(okStreamResult(events), stubModelCandidate(), 'anthropicMessages', ctx,
    event => readUsage(event as AnthropicMessagesStreamEventEx));
  await drainEvents(result);
  const metadata = result.type === 'events' ? await result.finalMetadata! : undefined;
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500);
  expect(warn).not.toHaveBeenCalled();
  expect(metadata?.billableUsage?.output).toBe(202);
  recordPerformance(ctx, mockPerfTelemetryContext(), false, 202, 16000);
  await Promise.all(pending);
  expect(recordSample).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ttftMs: 400, tpotUs: 77114 }));
});

test.each([
  { targetApi: 'openaiResponses' as const, event: { type: 'response.shell_call_output_content.delta', delta: { stdout: 'result' } }, outputType: 'shell_call_output' },
  { targetApi: 'openaiResponses' as const, event: { type: 'response.output_item.added', item: { type: 'function_call', caller: { type: 'program', caller_id: 'pg_1' } } }, outputType: 'function_call' },
  { targetApi: 'anthropicMessages' as const, event: { type: 'content_block_start', content_block: { type: 'web_search_tool_result', content: [] } }, outputType: 'web_search_tool_result' },
  { targetApi: 'anthropicMessages' as const, event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'lookup', caller: { type: 'code_execution_20260120', tool_id: 'program' } } }, outputType: 'tool_use' },
])('warns once for first runtime output in $targetApi: $outputType', async ({ targetApi, event, outputType }) => {
  const ctx = mockGatewayCtx();
  let now = 500;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => { now += 50; });
  const frames = [{ type: 'event' as const, event }, { type: 'event' as const, event }];
  const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), targetApi, ctx, () => null);
  expect(await drainEvents(result)).toEqual(frames);
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    'Floway: first output timing started from runtime output without an earlier decode signal in this response',
    { outputType, upstream: 'test-upstream', model: 'test-model', modelKey: 'test-model-key' },
  );
});
