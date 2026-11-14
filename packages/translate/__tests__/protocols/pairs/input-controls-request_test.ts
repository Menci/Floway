import { expect, test } from 'vitest';

import {
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  routeOpenAIResponsesViaAnthropicMessages,
  routeOpenAIResponsesViaOpenAIChatCompletions,
} from '../../../src/index.ts';
import { readAnthropicMessagesRequest } from '../../../src/protocols/anthropic-messages/as-source/input-to.ts';
import { readOpenAIChatCompletionsRequest } from '../../../src/protocols/openai-chat-completions/as-source/input-to.ts';
import { readOpenAIResponsesRequest } from '../../../src/protocols/openai-responses/as-source/input-to.ts';
import { buildTargetPayloadFor, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { deepFreeze } from '../../shared/deep-freeze.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

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
  { combined: 9, responsesCeiling: 9, messagesCeiling: 9 },
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

test('nullable token limits and cache controls remain explicit in source IR', async () => {
  const source = {
    model: 'm', stream: true, messages: [], max_tokens: null, max_completion_tokens: null,
    prompt_cache_options: null, prompt_cache_retention: null, user: null,
  };
  expect(readOpenAIChatCompletionsRequest(source).request.settings).toMatchObject({
    max_visible_output_tokens: null, max_output_tokens: null, prompt_cache_options: null, prompt_cache_retention: null, user: null,
  });
  const responses = await routeOpenAIChatCompletionsViaOpenAIResponses(source, options);
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target.max_output_tokens).toBeNull();
  const chat = await routeOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', stream: true, input: 'hi', max_output_tokens: null }, options);
  if (chat.type !== 'trip') throw new Error(chat.message);
  expect(chat.target.max_tokens).toBeNull();
  expect(chat.target.max_completion_tokens).toBeNull();
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

test('distinct content and scalar assistant refusals both remain in history', async () => {
  const result = await routeOpenAIChatCompletionsViaOpenAIResponses({
    model: 'm', stream: true, messages: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'first' }], refusal: 'second' }],
  }, options);
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target.input).toEqual([{
    type: 'message', role: 'assistant',
    content: [{ type: 'refusal', refusal: 'first' }, { type: 'refusal', refusal: 'second' }],
  }]);
});

test.each([
  { max_tokens: 5 },
  { max_tokens: 5, max_completion_tokens: 0 },
])('Chat token limits %j reach the modern Chat spelling after a Responses hop', async limits => {
  const first = await routeOpenAIChatCompletionsViaOpenAIResponses({ model: 'm', stream: true, messages: [], ...limits }, options);
  if (first.type !== 'trip') throw new Error(first.message);
  const second = await routeOpenAIResponsesViaOpenAIChatCompletions(first.target, options);
  if (second.type !== 'trip') throw new Error(second.message);
  const expected = limits.max_completion_tokens ?? limits.max_tokens;
  expect(second.target.max_tokens).toBe(expected);
  expect(second.target.max_completion_tokens).toBe(expected);
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

test('Responses controls cross the public Chat route without source-only include fields', async () => {
  const result = await routeOpenAIResponsesViaOpenAIChatCompletions({
    model: 'm', stream: true, input: 'hi', ...commonControls,
    include: ['reasoning.encrypted_content', 'message.output_text.logprobs', 'file_search_call.results'],
  }, options);
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target).toMatchObject({ ...commonControls, logprobs: true });
  expect(result.target).not.toHaveProperty('include');
});

test.each([false, null] as const)('Chat logprobs %j survives source reading and Responses projection', async logprobs => {
  const source = {
    model: 'm', stream: true, messages: [], logprobs, top_logprobs: null,
    prompt_cache_retention: null, prompt_cache_options: {}, user: '', presence_penalty: null, frequency_penalty: 0,
  };
  expect(readOpenAIChatCompletionsRequest(source).request.settings).toMatchObject({
    logprobs, top_logprobs: null, prompt_cache_retention: null, prompt_cache_options: {}, user: '', presence_penalty: null, frequency_penalty: 0,
  });
  const result = await routeOpenAIChatCompletionsViaOpenAIResponses(source, options);
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target).toMatchObject({
    top_logprobs: null, prompt_cache_retention: null, prompt_cache_options: {}, user: '', presence_penalty: null, frequency_penalty: 0,
  });
  expect(result.target.include).toEqual(logprobs === null ? null : []);
});

test.each([{ include: [] }, { include: null }])('Responses include $include states no requested logprobs while preserving zero controls', async ({ include }) => {
  const result = await routeOpenAIResponsesViaOpenAIChatCompletions({
    model: 'm', stream: true, input: 'hi', include: include === null ? null : [...include],
    prompt_cache_retention: '', prompt_cache_options: { mode: '', ttl: '' }, user: '',
    top_logprobs: 0, presence_penalty: 0, frequency_penalty: null,
  }, options);
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target).toMatchObject({
    logprobs: include === null ? null : false, prompt_cache_retention: '', prompt_cache_options: { mode: '', ttl: '' }, user: '',
    top_logprobs: 0, presence_penalty: 0, frequency_penalty: null,
  });
});

test('request settings carry frozen cache options through both directions', async () => {
  const source = deepFreeze({
    model: 'm', stream: true, messages: [], prompt_cache_options: { mode: 'explicit', ttl: '30m' },
  } satisfies OpenAIChatCompletionsPayload);
  const reading = readOpenAIChatCompletionsRequest(source);
  expect(reading.request.settings.prompt_cache_options).toBe(source.prompt_cache_options);
  const target = await buildTargetPayloadFor(pairs.chatToResponses[0], pairs.chatToResponses[1], source, options, reading);
  expect(target.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });

  const reverseSource = deepFreeze({ ...target, prompt_cache_options: { mode: 'explicit', ttl: '30m', prewarm: false } });
  const reverseReading = readOpenAIResponsesRequest(reverseSource);
  const reverseTarget = await buildTargetPayloadFor(pairs.responsesToChat[0], pairs.responsesToChat[1], reverseSource, options, reverseReading);
  expect(reverseTarget.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m' });
  expect(reverseSource.prompt_cache_options).toEqual({ mode: 'explicit', ttl: '30m', prewarm: false });
});

test.each(['auto', 'none'] as const)('orphan Messages %s stays in source IR and is omitted by both OpenAI writers', async type => {
  const source = { model: 'm', stream: true, max_tokens: 10, messages: [{ role: 'user' as const, content: 'A' }], tool_choice: { type } };
  expect(readAnthropicMessagesRequest(source).request.tool_choice).toBe(type);
  for (const route of [routeAnthropicMessagesViaOpenAIChatCompletions, routeAnthropicMessagesViaOpenAIResponses]) {
    const result = await route(source, options);
    if (result.type !== 'trip') throw new Error(result.message);
    expect(result.target).not.toHaveProperty('tools');
    expect(result.target).not.toHaveProperty('tool_choice');
  }
});

test('parallel tool control without declarations does not invent a Messages tool choice', async () => {
  const result = await routeOpenAIResponsesViaAnthropicMessages({
    model: 'm', stream: true, input: 'hi', tools: [], parallel_tool_calls: false,
  }, { ...options, fallbackMaxOutputTokens: 16 });
  if (result.type !== 'trip') throw new Error(result.message);
  expect(result.target).not.toHaveProperty('tool_choice');
});

test('tool selection never changes the complete allocated declaration inventory', async () => {
  const tools = [
    { type: 'namespace' as const, name: 'x', description: 'group', tools: [{ type: 'function' as const, name: 'f' }, { type: 'custom' as const, name: 'f' }] },
    { type: 'function' as const, name: 'x_f' },
  ];
  const choices: (OpenAIResponsesToolChoice | undefined)[] = [
    undefined, 'auto', 'none', 'required', { type: 'function', namespace: 'x', name: 'f' },
    { type: 'allowed_tools', mode: 'auto', tools: [] },
    { type: 'allowed_tools', mode: 'required', tools: [{ type: 'custom', namespace: 'x', name: 'f' }] },
  ];
  let declarations: unknown;
  for (const tool_choice of choices) {
    const result = await routeOpenAIResponsesViaOpenAIChatCompletions({ model: 'm', stream: true, input: 'hi', tools, tool_choice }, options);
    if (result.type !== 'trip') throw new Error(result.message);
    if (tool_choice === undefined) declarations = result.target.tools;
    expect(result.target.tools).toEqual(declarations);
    expect(result.target.tools).toHaveLength(3);
  }
});

test.each([[1024, 'low'], [32768, 'high']] as const)('Messages budget %i remains numeric until OpenAI target projection', async (budget_tokens, effort) => {
  const source = { model: 'm', stream: true, max_tokens: 60000, thinking: { type: 'enabled' as const, budget_tokens }, messages: [{ role: 'user' as const, content: 'hi' }] };
  const { settings } = readAnthropicMessagesRequest(source).request;
  expect(settings.reasoning_budget).toBe(budget_tokens);
  expect(settings).not.toHaveProperty('reasoning_effort');
  const chat = await routeAnthropicMessagesViaOpenAIChatCompletions(source, options);
  if (chat.type !== 'trip') throw new Error(chat.message);
  expect(chat.target.reasoning_effort).toBe(effort);
  const responses = await routeAnthropicMessagesViaOpenAIResponses(source, options);
  if (responses.type !== 'trip') throw new Error(responses.message);
  expect(responses.target.reasoning).toEqual({ effort });
});

test.each(['', 'custom-effort'] as const)('Messages explicit effort %j remains independent of its numeric budget', async effort => {
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
