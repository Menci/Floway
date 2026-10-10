import { afterEach, describe, expect, test, vi } from 'vitest';

import { billableUsageFromOpenAIResponsesEvent } from '../../../../src/data-plane/chat/openai-responses/usage.ts';
import { providerStreamResultToExecuteResult } from '../../../../src/data-plane/chat/shared/provider-stream-result.ts';
import { recordPerformance } from '../../../../src/data-plane/shared/telemetry/performance.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { mockPerfTelemetryContext, stubModelCandidate } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

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
  expect(stamps[0]).toBe(null);
  expect(stamps.slice(1)).toEqual(timeline.slice(1).map(() => 3596));
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
  expect(stamps).toEqual([null, null, 300, 300]);
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
  expect(stamps).toEqual([null, 200, 200]);
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
  expect(stamps.slice(0, 3)).toEqual([null, null, null]);
  expect(stamps.slice(3)).toEqual(timeline.slice(3).map(() => 500));
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
      expect(stamps).toEqual(withPriorCall ? [null, null, 300, 300, 300, 300] : [null, null, 500, 500, 500]);
      if (withPriorCall) {
        expect(warn).not.toHaveBeenCalled();
      } else {
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          'Floway: first output timing started from a runtime result without an earlier decode signal',
          { itemType: item.type, upstream: 'test-upstream', model: 'test-model', modelKey: 'test-model-key' },
        );
      }
    });
  });
});
