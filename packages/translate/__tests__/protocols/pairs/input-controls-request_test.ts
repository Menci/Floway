import { expect, test } from 'vitest';

import {
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
} from '../../../src/index.ts';
import { readAnthropicMessagesRequest } from '../../../src/protocols/anthropic-messages/as-source/input-to.ts';
import { readOpenAIChatCompletionsRequest } from '../../../src/protocols/openai-chat-completions/as-source/input-to.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';

const options = { sidecarCodec: createTestSidecarCodec() };

test('an explicitly empty Chat assistant content array remains a turn on both targets', async () => {
  const source = { model: 'm', stream: true, messages: [{ role: 'assistant' as const, content: [] }] };
  const responses = await routeOpenAIChatCompletionsViaOpenAIResponses(source, options);
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target.input).toEqual([{ type: 'message', role: 'assistant', content: '' }]);

  const messages = await routeOpenAIChatCompletionsViaAnthropicMessages(source, { ...options, fallbackMaxOutputTokens: 16 });
  if (messages.type !== 'trip') throw new Error(messages.message);
  expect(messages.target.messages).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '', cache_control: { type: 'ephemeral' } }] }]);
});

test.each([
  { combined: 0, responsesCeiling: 0, messagesCeiling: 0 },
  { combined: null, responsesCeiling: null, messagesCeiling: 5 },
])('Chat keeps both output bounds until target projection with combined ceiling $combined', async ({ combined, responsesCeiling, messagesCeiling }) => {
  const source = { model: 'm', stream: true, messages: [{ role: 'user' as const, content: 'A' }], max_tokens: 5, max_completion_tokens: combined };
  const { settings } = readOpenAIChatCompletionsRequest(source).request;
  expect(settings).toMatchObject({ max_visible_output_tokens: 5, max_output_tokens: combined });
  expect(settings).not.toHaveProperty('max_tokens');
  expect(settings).not.toHaveProperty('max_completion_tokens');

  const responses = await routeOpenAIChatCompletionsViaOpenAIResponses(source, options);
  expect(responses.type).toBe('trip');
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target.max_output_tokens).toBe(responsesCeiling);
  const messages = await routeOpenAIChatCompletionsViaAnthropicMessages(source, options);
  expect(messages.type).toBe('trip');
  if (messages.type !== 'trip') throw new Error(messages.message);
  expect(messages.target.max_tokens).toBe(messagesCeiling);
});

test('nullable Chat sampling, storage, parallelism and schema strictness remain explicit', async () => {
  const source = {
    model: 'm', stream: true, messages: [], temperature: null, top_p: null, store: null, parallel_tool_calls: null as never,
    response_format: { type: 'json_schema' as const, json_schema: { name: 'result', schema: {}, strict: null } },
  };
  expect(readOpenAIChatCompletionsRequest(source).request.settings).toMatchObject({
    temperature: null, top_p: null, store: null, parallel_tool_calls: null,
    output_format: { type: 'json_schema', name: 'result', schema: {}, strict: null },
  });
  const responses = await routeOpenAIChatCompletionsViaOpenAIResponses(source, options);
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target).toMatchObject({
    temperature: null, top_p: null, store: null, parallel_tool_calls: null,
    text: { format: { type: 'json_schema', name: 'result', schema: {}, strict: null } },
  });
});

const commonControls = {
  prompt_cache_retention: '24h',
  prompt_cache_options: { mode: 'explicit', ttl: '30m' },
  user: 'opaque-u',
  top_logprobs: 4,
  presence_penalty: 0.7,
  frequency_penalty: -0.2,
} as const;

test('Chat controls cross the public Responses route with their independent semantics', async () => {
  const result = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }], ...commonControls, logprobs: true,
  }, options);
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target).toMatchObject(commonControls);
  expect(result.target.include).toEqual(['message.output_text.logprobs']);
});

test.each(['auto'] as const)('orphan Messages %s stays in source IR and is omitted by both OpenAI writers', async type => {
  const source = { model: 'm', stream: true, max_tokens: 10, messages: [{ role: 'user' as const, content: 'A' }], tool_choice: { type } };
  expect(readAnthropicMessagesRequest(source).request.tool_choice).toBe(type);
  for (const route of [routeAnthropicMessagesViaOpenAIChatCompletions, routeAnthropicMessagesViaOpenAIResponses]) {
    const result = await route(source, options);
    if (result.type !== 'trip') throw new Error(result.message);
    expect(result.target).not.toHaveProperty('tools');
    expect(result.target).not.toHaveProperty('tool_choice');
  }
});

test.each([''] as const)('Messages explicit effort %j remains independent of its numeric budget', async effort => {
  const source = {
    model: 'm', stream: true, max_tokens: 60000, messages: [],
    thinking: { type: 'enabled' as const, budget_tokens: 32768 }, output_config: { effort },
  };
  expect(readAnthropicMessagesRequest(source).request.settings).toMatchObject({ reasoning_budget: 32768, reasoning_effort: effort });
  const chat = await routeAnthropicMessagesViaOpenAIChatCompletions(source, options);
  if (chat.type !== 'trip') throw new Error(chat.message);
  expect(chat.target.reasoning_effort).toBe(effort);
  const responses = await routeAnthropicMessagesViaOpenAIResponses(source, options);
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target.reasoning).toEqual({ effort });
});
