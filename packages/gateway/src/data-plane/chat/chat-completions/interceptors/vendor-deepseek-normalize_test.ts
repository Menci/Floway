import { test } from 'vitest';

import type { ChatCompletionsInvocation } from './types.ts';
import { withVendorDeepseekChatCompletionsNormalize } from './vendor-deepseek-normalize.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

type DeepseekReasoningDelta = ChatCompletionsStreamEvent['choices'][number]['delta'] & {
  reasoning_content?: string;
};

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const invocation = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set(['vendor-deepseek'])): ChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'chat-completions',
  headers: new Headers(),
});

const baseRequest = (): ChatCompletionsPayload => ({
  model: 'deepseek-reasoner',
  messages: [
    { role: 'user', content: 'first turn' },
    {
      role: 'assistant',
      content: null,
      reasoning_text: 'let me check the docs',
      reasoning_opaque: 'opaque-blob',
      reasoning_items: [{ type: 'reasoning', summary: [] }],
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    { role: 'user', content: 'next turn' },
  ],
});

const collectFrames = async (result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const usageRecord = (usage: NonNullable<ChatCompletionsStreamEvent['usage']>): Record<string, unknown> => usage as unknown as Record<string, unknown>;

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

// ── Outbound: assistant reasoning field rewrite ──

test('renames outbound reasoning_text to reasoning_content on assistant messages', async () => {
  const ctx = invocation(baseRequest());

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, 'let me check the docs');
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  assertEquals((assistant.tool_calls as unknown[]).length, 1);
});

test('synthesizes reasoning_content from reasoning_items when reasoning_text is absent', async () => {
  const ctx = invocation({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: null,
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_1',
            summary: [
              { type: 'summary_text', text: 'step one. ' },
              { type: 'summary_text', text: 'step two.' },
            ],
          },
        ],
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, 'step one. step two.');
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
});

test('strips reasoning_items even when no summaries are available', async () => {
  const ctx = invocation({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'answer',
        reasoning_items: [{ type: 'reasoning' }],
        reasoning_opaque: 'opaque-chain',
      },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.content, 'answer');
});

// ── Outbound: reasoning_effort === 'none' canonical sentinel ──

test("translates canonical reasoning_effort: 'none' into top-level thinking:{type:'disabled'}", async () => {
  const ctx = invocation({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.reasoning_effort, undefined);
  assertEquals(out.thinking, { type: 'disabled' });
});

test('leaves a real reasoning_effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const ctx = invocation({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'high');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});

// ── Outbound: structured-output json_schema downgrade ──

test('downgrades response_format json_schema to json_object (schema body dropped)', async () => {
  const ctx = invocation({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'messages_response',
        strict: true,
        schema: { type: 'object', properties: { test: { type: 'string' } }, required: ['test'], additionalProperties: false },
      },
    },
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.response_format, { type: 'json_object' });
});

test('leaves an already-json_object response_format untouched', async () => {
  const ctx = invocation({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.response_format, { type: 'json_object' });
});

// ── Inbound: delta reasoning_content → reasoning_text ──

test('renames inbound protocol reasoning_content deltas to reasoning_text', async () => {
  const ctx = invocation(baseRequest());
  const upstreamChunk: ChatCompletionsStreamEvent = {
    id: 'chunk_1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-reasoner',
    choices: [
      {
        index: 0,
        delta: { reasoning_content: 'thinking...' } as DeepseekReasoningDelta,
        finish_reason: null,
      },
    ],
  };

  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () { yield eventFrame(upstreamChunk); })(),
      testTelemetryModelIdentity,
    )));

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const delta = frame.event.choices[0].delta as Record<string, unknown>;
  assertEquals(delta.reasoning_text, 'thinking...');
  assertEquals(delta.reasoning_content, undefined);
});

test('preserves reasoning_content from non-stream JSON responses', async () => {
  const ctx = invocation(baseRequest());
  const id = 'chatcmpl_deepseek_json';
  const model = 'deepseek-reasoner';
  const chunk = (delta: ChatCompletionsStreamEvent['choices'][number]['delta'], finish_reason: 'stop' | null = null): ChatCompletionsStreamEvent => ({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });

  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        yield eventFrame(chunk({ role: 'assistant' }));
        yield eventFrame(chunk({ reasoning_content: 'json thinking' } as ChatCompletionsStreamEvent['choices'][number]['delta']));
        yield eventFrame(chunk({ content: 'answer' }));
        yield eventFrame(chunk({}, 'stop'));
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    )));

  const frames = await collectFrames(result);
  const reasoningFrame = frames.find(frame => frame.type === 'event' && frame.event.choices[0]?.delta.reasoning_text !== undefined);
  assertEquals(reasoningFrame?.type === 'event' ? reasoningFrame.event.choices[0]?.delta.reasoning_text : undefined, 'json thinking');
});

// ── Inbound: usage cache-token field rewrite ──

test('rewrites prompt_cache_hit_tokens/prompt_cache_miss_tokens into prompt_tokens_details.cached_tokens', async () => {
  const ctx = invocation(baseRequest());
  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        yield eventFrame({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'deepseek-test',
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_cache_hit_tokens: 70,
            prompt_cache_miss_tokens: 30,
          } as unknown as ChatCompletionsStreamEvent['usage'],
        });
      })(),
      testTelemetryModelIdentity,
    )));

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens, 100);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 70 });
  assertEquals('prompt_cache_hit_tokens' in usage, false);
  assertEquals('prompt_cache_miss_tokens' in usage, false);
});

// ── Pass-through ──

test('leaves protocol done frames untouched', async () => {
  const ctx = invocation(baseRequest());
  const done = doneFrame();

  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () { yield done; })(),
      testTelemetryModelIdentity,
    )));

  assertEquals(await collectFrames(result), [done]);
});

test('early-returns when its flag is not set on the candidate', async () => {
  const ctx = invocation(
    {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'none');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});
