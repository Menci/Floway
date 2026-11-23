import { expect, test } from 'vitest';

import { applyRoleCompatibility } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/disable-reasoning-on-forced-tool-choice.ts';
import { includeUsageStreamOptions } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokens } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/normalize-exclusive-cached-tokens.ts';
import { normalizeUsage } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/normalize-usage.ts';
import { stripPromptCacheKey } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/strip-prompt-cache-key.ts';
import { normalizeDeepSeekRequest } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/vendor-deepseek-request.ts';
import { normalizeDeepSeekResponse } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/vendor-deepseek-response.ts';
import { normalizeKimiResponse } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/vendor-kimi-response.ts';
import { normalizeQwenRequest } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/vendor-qwen-request.ts';
import { driveChatStages } from '../../shared/drive-stages.ts';
import { chatUpstream } from '../../shared/fixture.ts';
import type { Stage } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type {
  OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsAssistantMessageEx,
  OpenAIChatCompletionsPayloadEx as Payload, OpenAIChatCompletionsStreamEvent as Event,
} from '@floway-dev/protocols/openai-chat-completions';
import type { FlagId } from '@floway-dev/provider';

const user = { role: 'user', content: 'hello' } as const;
const payload = (overrides: Partial<Payload> = {}): Payload => ({ model: 'test-model', messages: [user], ...overrides });
const event = (overrides: Partial<Event> = {}): Event => ({ id: 'chunk', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [], ...overrides });
const functionTool = { type: 'function', function: { name: 'lookup' } } as const;

const request = (body: Payload, flags: readonly FlagId[]) => ({
  'request.openaiChatCompletions': body,
  'request.payload': body,
  'route.targetApi': 'openaiChatCompletions',
  'route.candidate': chatUpstream({ flags, endpoints: { openaiChatCompletions: {} } }).candidate,
});

const bodyRequest = async (stage: Stage, body: Payload, flags: readonly FlagId[] = []) =>
  (await driveChatStages([stage], request(body, flags), { key: 'response.openaiChatCompletions' })).request['request.openaiChatCompletions'];

const egressEvents = async (stages: readonly Stage[], events: readonly Event[], flags: readonly FlagId[] = []) => {
  const result = await driveChatStages(stages, request(payload(), flags), { key: 'response.events', frames: events.map(eventFrame) });
  return result.frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
};

test('preserves sibling stream_options keys while forcing include_usage on', async () => {
  const source = payload({ stream_options: { include_usage: false, continuous_usage_stats: true } });
  const result = await bodyRequest(includeUsageStreamOptions, source);
  expect(result.stream_options).toEqual({ include_usage: true, continuous_usage_stats: true });
  expect(source.stream_options?.include_usage).toBe(false);
});

test('required tool_choice sets reasoning_effort to the canonical none sentinel', async () => {
  const result = await bodyRequest(disableReasoningOnForcedToolChoice, payload({ tool_choice: 'required', reasoning_effort: 'high' }), ['disable-reasoning-on-forced-tool-choice']);
  expect(result.reasoning_effort).toBe('none');
});

test.each([
  [[], 'none'],
  [undefined, 'auto'],
  [[functionTool], 'auto'],
] as const)('normalizes tool choice for tools %j to %s', async (tools, choice) => {
  const source = payload({ tool_choice: 'auto', ...(tools === undefined ? {} : { tools: [...tools] }) });
  const result = await bodyRequest(normalizeEmptyToolsToolChoice, source, ['empty-tools-tool-choice-none']);
  expect(result.tool_choice).toBe(choice);
  expect(result.tools).toEqual(tools);
});

test('drops top-level prompt_cache_key when the flag is on', async () => {
  const source = payload({ prompt_cache_key: 'cache' });
  const result = await bodyRequest(stripPromptCacheKey, source, ['strip-prompt-cache-key']);
  expect(result).not.toHaveProperty('prompt_cache_key');
  expect(source.prompt_cache_key).toBe('cache');
});

test.each([
  [['rewrite-system-to-developer'], ['developer', 'developer', 'user', 'developer']],
  [['rewrite-developer-to-system'], ['system', 'system', 'user', 'system']],
  [['rewrite-system-to-developer', 'rewrite-developer-to-system', 'rewrite-mid-conv-system-to-user'], ['system', 'system', 'user', 'user']],
] satisfies [FlagId[], string[]][])('applies native role flags %j in order', async (flags, roles) => {
  const source = payload({
    messages: [
      { role: 'system', content: 'base' }, { role: 'developer', content: 'developer' }, user, { role: 'system', content: 'inline' },
    ],
  });
  const { request: observed } = await driveChatStages([applyRoleCompatibility], request(source, flags), { key: 'response.events' });
  expect(observed['request.payload'].messages.map(message => message.role)).toEqual(roles);
});

test('relocates usage from a non-empty choices chunk onto a synthesized carrier', async () => {
  const finish = event({
    choices: [{ index: 0, delta: { content: 'last' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });
  const { frames } = await driveChatStages([normalizeUsage], request(payload(), []), {
    key: 'response.openaiChatCompletions', frames: [eventFrame(finish), doneFrame()],
  });
  const { usage, ...chunk } = finish;
  expect(frames).toEqual([eventFrame(chunk), eventFrame({ ...chunk, choices: [], usage }), doneFrame()]);
});

test('folds exclusive cached tokens on the totals alone, with no flag set', async () => {
  const [chunk] = await egressEvents([normalizeExclusiveCachedTokens], [event({
    usage: { prompt_tokens: 479, completion_tokens: 373, total_tokens: 14164, prompt_tokens_details: { cached_tokens: 13312 } },
  })]);
  expect(chunk.usage).toEqual({
    prompt_tokens: 13791, completion_tokens: 373, total_tokens: 14164, prompt_tokens_details: { cached_tokens: 13312 },
  });
});

test('renames outbound DeepSeek thinking and synthesizes replay from reasoning summaries', async () => {
  const toolCalls = [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] as const;
  const first: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: null, reasoning_text: 'check docs', reasoning_opaque: 'state', tool_calls: [...toolCalls] };
  const second: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant', content: null, tool_calls: [...toolCalls],
    reasoning_items: [{ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'step one. ' }, { type: 'summary_text', text: 'step two.' }] }],
  };
  const result = await bodyRequest(normalizeDeepSeekRequest, payload({ messages: [user, first, second] }), ['vendor-deepseek']);
  expect(result.messages).toEqual([
    user,
    { role: 'assistant', content: null, tool_calls: toolCalls, reasoning_content: 'check docs' },
    { role: 'assistant', content: null, tool_calls: toolCalls, reasoning_content: 'step one. step two.' },
  ]);
});

test('DeepSeek maps the reasoning disable sentinel and downgrades json_schema', async () => {
  const source = payload({
    reasoning_effort: 'none',
    response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: { type: 'object' } } },
  });
  const result = await bodyRequest(normalizeDeepSeekRequest, source, ['vendor-deepseek']);
  expect(result).not.toHaveProperty('reasoning_effort');
  expect(result).toMatchObject({ thinking: { type: 'disabled' }, response_format: { type: 'json_object' } });
});

test('DeepSeek renames inbound reasoning and cache figures before exclusive accounting', async () => {
  const delta: OpenAIChatCompletionsAssistantDeltaEx = { reasoning_content: 'thinking...' };
  const usage = {
    prompt_tokens: 30, completion_tokens: 20, total_tokens: 120,
    prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30, prompt_tokens_details: { upstream_metric: 'preserved', audio_tokens: 2 },
  };
  const [chunk] = await egressEvents([normalizeExclusiveCachedTokens, normalizeDeepSeekResponse], [event({
    choices: [{ index: 0, delta, finish_reason: null }], usage,
  })], ['vendor-deepseek']);
  expect(chunk.choices[0].delta).toEqual({ reasoning_text: 'thinking...' });
  expect(chunk.usage).toEqual({
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { upstream_metric: 'preserved', audio_tokens: 2, cached_tokens: 70 },
  });
});

test('Qwen translates the reasoning disable sentinel into enable_thinking:false', async () => {
  const result = await bodyRequest(normalizeQwenRequest, payload({ reasoning_effort: 'none' }), ['vendor-qwen']);
  expect(result).not.toHaveProperty('reasoning_effort');
  expect(result).toMatchObject({ enable_thinking: false });
});

test('Kimi rewrites flat cached_tokens into prompt_tokens_details.cached_tokens', async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 60 };
  const [chunk] = await egressEvents([normalizeKimiResponse], [event({ usage })], ['vendor-kimi']);
  expect(chunk.usage).toEqual({
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 },
  });
});
