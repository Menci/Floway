import { test } from 'vitest';

import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { withVendorDeepSeekOpenAIChatCompletionsNormalize } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/vendor-deepseek-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsUsageEx, OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

type DeepSeekReasoningDelta = OpenAIChatCompletionsAssistantDeltaEx & {
  reasoning_content?: string;
};

const stubCtx = mockChatGatewayCtx();

const invocation = (payload: OpenAIChatCompletionsPayload, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-deepseek'])): OpenAIChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiChatCompletions',
  headers: new Headers(),
});

const baseRequest = (): OpenAIChatCompletionsPayload => ({
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
    } as OpenAIChatCompletionsAssistantMessageEx,
    { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    { role: 'user', content: 'next turn' },
  ],
});

const collectFrames = async (result: ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): Promise<ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const usageRecord = (usage: OpenAIChatCompletionsUsageEx): Record<string, unknown> => usage as unknown as Record<string, unknown>;

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

// ── Outbound: assistant reasoning field rewrite ──

test('renames outbound reasoning_text to reasoning_content on assistant messages', async () => {
  const ctx = invocation(baseRequest());

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorDeepSeekOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
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
      } as OpenAIChatCompletionsAssistantMessageEx,
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ],
  });

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorDeepSeekOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const assistant = observed!.messages[1] as unknown as Record<string, unknown>;
  assertEquals(assistant.reasoning_content, 'step one. step two.');
  assertEquals(assistant.reasoning_text, undefined);
  assertEquals(assistant.reasoning_opaque, undefined);
  assertEquals(assistant.reasoning_items, undefined);
});

// ── Outbound: reasoning_effort === 'none' canonical sentinel ──

test("translates canonical reasoning_effort: 'none' into top-level thinking:{type:'disabled'}", async () => {
  const ctx = invocation({
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorDeepSeekOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.reasoning_effort, undefined);
  assertEquals(out.thinking, { type: 'disabled' });
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

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorDeepSeekOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.response_format, { type: 'json_object' });
});

// ── Inbound: delta reasoning_content → reasoning_text ──

test('renames inbound protocol reasoning_content deltas to reasoning_text', async () => {
  const ctx = invocation(baseRequest());
  const upstreamChunk: OpenAIChatCompletionsStreamEvent = {
    id: 'chunk_1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-reasoner',
    choices: [
      {

        index: 0,
        delta: { reasoning_content: 'thinking...' } as DeepSeekReasoningDelta,
        finish_reason: null,
      },
    ],
  };

  const result = await withVendorDeepSeekOpenAIChatCompletionsNormalize(ctx, stubCtx, () =>
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

// ── Inbound: usage cache-token field rewrite ──

test('rewrites prompt_cache_hit_tokens/prompt_cache_miss_tokens into prompt_tokens_details.cached_tokens', async () => {
  const ctx = invocation(baseRequest());
  const result = await withVendorDeepSeekOpenAIChatCompletionsNormalize(ctx, stubCtx, () =>
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
            prompt_tokens_details: { upstream_metric: 'preserved' },
          } as unknown as OpenAIChatCompletionsStreamEvent['usage'],
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
  assertEquals(usage.prompt_tokens_details, { upstream_metric: 'preserved', cached_tokens: 70 });
  assertEquals('prompt_cache_hit_tokens' in usage, false);
  assertEquals('prompt_cache_miss_tokens' in usage, false);
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

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorDeepSeekOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'none');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.thinking, undefined);
});
