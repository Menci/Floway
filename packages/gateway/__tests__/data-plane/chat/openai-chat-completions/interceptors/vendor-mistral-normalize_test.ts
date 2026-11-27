import { test } from 'vitest';

import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { withVendorMistralOpenAIChatCompletionsNormalize } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/vendor-mistral-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { eventResult, type FlagId } from '@floway-dev/upstream';

const stubCtx = mockChatGatewayCtx();

const invocation = (payload: unknown, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-mistral'])): OpenAIChatCompletionsInvocation => ({
  payload: payload as OpenAIChatCompletionsPayload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiChatCompletions',
  headers: new Headers(),
});

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const run = async (ctx: OpenAIChatCompletionsInvocation): Promise<unknown> => {
  let observed: unknown = null;
  await withVendorMistralOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });
  return observed;
};

const validRequest = () => ({
  model: 'mistral-large-latest',
  messages: [
    { role: 'system', content: 'be brief' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: null,
      prefix: false,
      tool_calls: [{ id: 'abc123xyz', type: 'function', index: 0, function: { name: 'f', arguments: '{}' } }],
    },
    { role: 'tool', content: 'ok', tool_call_id: 'abc123xyz', name: 'f' },
  ],
  temperature: 0.5,
  top_p: 1,
  max_tokens: 100,
  stream: true,
  stream_options: { include_usage: true },
  stop: ['x'],
  random_seed: 1,
  response_format: { type: 'json_object' },
  tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' }, strict: true } }],
  tool_choice: 'auto',
  presence_penalty: 0,
  frequency_penalty: 0,
  n: 1,
  parallel_tool_calls: true,
  reasoning_effort: 'high',
  prompt_cache_key: 'k',
  safe_prompt: false,
});

test('leaves the payload untouched when the flag is not set', async () => {
  const payload = { ...validRequest(), unknown_field: 1, stream_options: { include_usage: true, continuous_usage_stats: true } };
  const ctx = invocation(payload, new Set());
  assertEquals(await run(ctx), payload);
});

test('passes a fully populated valid request through unchanged', async () => {
  const ctx = invocation(validRequest());
  assertEquals(await run(ctx), validRequest());
});

test('drops continuous_usage_stats but keeps include_usage', async () => {
  const ctx = invocation({ ...validRequest(), stream_options: { include_usage: true, continuous_usage_stats: true } });
  assertEquals((await run(ctx) as { stream_options: unknown }).stream_options, { include_usage: true });
});

test('drops the client metadata even though Mistral defines the field', async () => {
  const metadata = { user_id: '{"device_id":"d","account_uuid":"","session_id":"s"}' };
  const ctx = invocation({ ...validRequest(), metadata });
  assertEquals(await run(ctx), validRequest());
});

// Translation onto Chat Completions states the cap only as max_completion_tokens.
test('moves the translated output cap into max_tokens', async () => {
  const { max_tokens: _cap, ...request } = validRequest();
  const ctx = invocation({ ...request, max_completion_tokens: 2048 });
  assertEquals(await run(ctx), { ...request, max_tokens: 2048 });
});

test('keeps a max_tokens the request already carries', async () => {
  const ctx = invocation({ ...validRequest(), max_completion_tokens: 2048 });
  assertEquals(await run(ctx), validRequest());
});

test('drops stream_options when nothing Mistral accepts remains', async () => {
  const ctx = invocation({ ...validRequest(), stream_options: { continuous_usage_stats: true } });
  assertEquals(Object.hasOwn(await run(ctx) as object, 'stream_options'), false);
});

test('drops unknown fields from replayed assistant messages, tool calls, and unknown top-level keys', async () => {
  const request = validRequest();
  const ctx = invocation({
    ...request,
    enable_thinking: false,
    messages: [
      ...request.messages.slice(0, 2),
      {
        role: 'assistant',
        content: 'hello',
        refusal: null,
        index: 0,
        reasoning_content: 'thinking',
        tool_calls: [{ id: 'abc123xyz', type: 'function', index: 0, extra: 1, function: { name: 'f', arguments: '{}', extra: 2 } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'abc123xyz', name: 'f', extra: 3 },
      { role: 'user', content: 'again', name: 'u' },
    ],
    tools: [{ type: 'function', extra: 1, function: { name: 'f', parameters: {}, extra: 2 } }],
  });

  assertEquals(await run(ctx), {
    ...request,
    messages: [
      ...request.messages.slice(0, 2),
      {
        role: 'assistant',
        content: 'hello',
        tool_calls: [{ id: 'abc123xyz', type: 'function', index: 0, function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'abc123xyz', name: 'f' },
      { role: 'user', content: 'again' },
    ],
    tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
  });
});

test('leaves messages of a role Mistral does not define as they are', async () => {
  const request = validRequest();
  const developer = { role: 'developer', content: 'answer in French', name: 'ops' };
  const ctx = invocation({ ...request, messages: [developer, ...request.messages] });

  assertEquals(await run(ctx), { ...request, messages: [developer, ...request.messages] });
});
