import { test } from 'vitest';

import { chatCompletionsInvocation, stubRequestContext, testTelemetryModelIdentity } from './test-helpers.ts';
import { withVendorDeepseekChatCompletionsNormalize } from './vendor-deepseek-normalize.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import type { ExecuteResult } from '../../../shared/errors/result.ts';
import { eventResult } from '../../../shared/errors/result.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

type DeepseekReasoningDelta = ChatCompletionChunk['choices'][number]['delta'] & {
  reasoning_content?: string;
};

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
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'result',
    },
    { role: 'user', content: 'next turn' },
  ],
});

const exchangeCtx = (payload: ChatCompletionsPayload = baseRequest()): ReturnType<typeof chatCompletionsInvocation> =>
  chatCompletionsInvocation(payload, new Set(['vendor-deepseek']));

const collectFrames = async (result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>>): Promise<ProtocolFrame<ChatCompletionChunk>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<ChatCompletionChunk>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const usageRecord = (usage: NonNullable<ChatCompletionChunk['usage']>): Record<string, unknown> => usage as unknown as Record<string, unknown>;

// ── Outbound: assistant reasoning field rewrite ──

test('vendor-deepseek renames outbound reasoning_text to reasoning_content on assistant messages', async () => {
  const ctx = exchangeCtx();

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, 'let me check the docs');
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  // Non-reasoning fields stay intact so the tool-call replay still works.
  assertEquals((assistant.tool_calls as unknown[]).length, 1);
});

test('vendor-deepseek synthesizes reasoning_content from reasoning_items when reasoning_text is absent', async () => {
  const ctx = exchangeCtx({
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
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, 'step one. step two.');
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
});

test('vendor-deepseek strips reasoning_items even when no summaries are available', async () => {
  const ctx = exchangeCtx({
    model: 'deepseek-reasoner',
    messages: [
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: 'answer',
        reasoning_items: [
          {
            type: 'reasoning',
          },
        ],
        reasoning_opaque: 'opaque-chain',
      },
    ],
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, undefined);
  assertEquals(assistant.reasoning_items, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.content, 'answer');
});

// ── Outbound: reasoning_effort === 'none' canonical sentinel ──

test("vendor-deepseek translates canonical reasoning_effort: 'none' into top-level thinking:{type:'disabled'}", async () => {
  const ctx = exchangeCtx({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.reasoning_effort, undefined);
  assertEquals(out.thinking, { type: 'disabled' });
});

test('vendor-deepseek leaves a real reasoning_effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const ctx = exchangeCtx({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  assertEquals(observed!.reasoning_effort, 'high');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});

// ── Outbound: structured-output json_schema downgrade ──

test('vendor-deepseek downgrades response_format json_schema to json_object (schema body dropped)', async () => {
  const ctx = exchangeCtx({
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
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  assertEquals(observed!.response_format, { type: 'json_object' });
});

test('vendor-deepseek leaves an already-json_object response_format untouched', async () => {
  const ctx = exchangeCtx({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_object' },
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(
      eventResult(
        (async function* () {
          yield* [];
        })(),
        testTelemetryModelIdentity,
      ),
    );
  });

  assertEquals(observed!.response_format, { type: 'json_object' });
});

// ── Inbound: delta reasoning_content → reasoning_text ──

test('vendor-deepseek renames inbound protocol reasoning_content deltas to reasoning_text', async () => {
  const ctx = exchangeCtx();
  const upstreamChunk: ChatCompletionChunk = {
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

  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield eventFrame(upstreamChunk);
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const delta = frame.event.choices[0].delta as Record<string, unknown>;
  assertEquals(delta.reasoning_text, 'thinking...');
  assertEquals(delta.reasoning_content, undefined);
});

test('vendor-deepseek preserves reasoning_content from non-stream JSON responses', async () => {
  const ctx = exchangeCtx();
  const id = 'chatcmpl_deepseek_json';
  const model = 'deepseek-reasoner';
  const chunk = (delta: ChatCompletionChunk['choices'][number]['delta'], finish_reason: 'stop' | null = null): ChatCompletionChunk => ({
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason }],
  });

  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield eventFrame(chunk({ role: 'assistant' }));
          // DeepSeek's legacy non-stream JSON exposes the scalar as reasoning_content.
          // The vendor interceptor must normalize it to reasoning_text.
          yield eventFrame(chunk({ reasoning_content: 'json thinking' } as ChatCompletionChunk['choices'][number]['delta']));
          yield eventFrame(chunk({ content: 'answer' }));
          yield eventFrame(chunk({}, 'stop'));
          yield doneFrame();
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  const frames = await collectFrames(result);
  const reasoningFrame = frames.find(frame => frame.type === 'event' && frame.event.choices[0]?.delta.reasoning_text !== undefined);

  assertEquals(reasoningFrame?.type === 'event' ? reasoningFrame.event.choices[0]?.delta.reasoning_text : undefined, 'json thinking');
});

// ── Inbound: usage cache-token field rewrite ──

test('vendor-deepseek rewrites prompt_cache_hit_tokens/prompt_cache_miss_tokens into prompt_tokens_details.cached_tokens', async () => {
  const ctx = exchangeCtx();
  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () =>
    Promise.resolve(
      eventResult(
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
            } as unknown as ChatCompletionChunk['usage'],
          });
        })(),
        testTelemetryModelIdentity,
      ),
    ));

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

test('vendor-deepseek leaves protocol done frames untouched', async () => {
  const ctx = exchangeCtx();
  const done = doneFrame();

  const result = await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          yield done;
        })(),
        testTelemetryModelIdentity,
      ),
    ));

  assertEquals(await collectFrames(result), [done]);
});

test('vendor-deepseek early-returns when its flag is not set on the binding', async () => {
  const ctx = chatCompletionsInvocation(
    {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withVendorDeepseekChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return Promise.resolve(eventResult((async function* () { yield* []; })(), testTelemetryModelIdentity));
  });

  // None-sentinel survives untouched because the vendor flag is off.
  assertEquals(observed!.reasoning_effort, 'none');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});
