import { expect, test } from 'vitest';

import { collectIR, geminiGenerateContentFromIR, irFromAnthropicMessages, irFromOpenAIChatCompletions, irFromOpenAIResponses, iterate, openaiChatCompletionsFromIR, openaiResponsesFromIR } from './helpers.ts';
import { fixtureFrames } from './translation-cases.ts';
import { usageFromIR as messagesUsageFromIR } from '../../src/protocols/anthropic-messages/as-source/usage.ts';
import { usageToIR as messagesUsageToIR } from '../../src/protocols/anthropic-messages/as-target/usage.ts';
import { usageFromIR } from '../../src/protocols/gemini-generate-content/as-source/usage.ts';
import { usageFromIR as chatUsageFromIR } from '../../src/protocols/openai-chat-completions/as-source/usage.ts';
import { usageToIR as chatUsageToIR } from '../../src/protocols/openai-chat-completions/as-target/usage.ts';
import { usageFromIR as responsesUsageFromIR } from '../../src/protocols/openai-responses/as-source/usage.ts';
import { usageToIR as responsesUsageToIR } from '../../src/protocols/openai-responses/as-target/usage.ts';import { eventFrame } from '@floway-dev/protocols/common';

const initialUsage = { input_tokens: 17, output_tokens: 2, total_tokens: 19, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 } };
const sources = [
  ['ChatCompletions', irFromOpenAIChatCompletions, { id: 'resp_usage', model: 'served', created: 1, choices: [], service_tier: 'priority', usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 } } }, 'priority'],
  ['Responses', irFromOpenAIResponses, { type: 'response.created', response: { id: 'resp_usage', model: 'served', created_at: 1, status: 'in_progress', output: [], service_tier: 'fast', usage: initialUsage } }, 'fast'],
  ['Messages', irFromAnthropicMessages, { type: 'message_start', message: { id: 'msg_usage', model: 'served', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, speed: 'fast' } } }, 'fast'],
] as const;

test.each(sources)('Responses via %s exposes known initial accounting before pulling another upstream frame', async (_name, reader, event, tier) => {
  let pulledNext = false;
  const upstream = async function* () {
    yield eventFrame(event as any);
    pulledNext = true;
    throw new Error('The converter pulled past the initial upstream frame');
  };
  const stream = openaiResponsesFromIR(reader(upstream()));
  try {
    for (const type of ['response.created', 'response.in_progress']) {
      const frame = (await stream.next()).value;
      expect(frame).toMatchObject({ type: 'event', event: { type, response: { model: 'served', service_tier: tier, usage: initialUsage } } });
      expect(pulledNext).toBe(false);
    }
  } finally {
    await stream.return(undefined);
  }
});

test('Responses preserves absent initial accounting and later measured usage', async () => {
  const upstream = [
    { type: 'response.created', response: { id: 'resp_usage', model: 'served', created_at: 1, status: 'in_progress', output: [], usage: null } },
    { type: 'response.completed', response: { id: 'resp_usage', model: 'served', created_at: 1, status: 'completed', output: [], service_tier: 'fast', usage: initialUsage } },
  ].map(event => eventFrame(event as any));
  const output = [];
  for await (const frame of openaiResponsesFromIR(irFromOpenAIResponses(iterate(upstream)))) output.push(frame);
  expect(output[0]).toMatchObject({ event: { response: { usage: null } } });
  expect(output[0].type === 'event' && output[0].event.type === 'response.created' && output[0].event.response).not.toHaveProperty('service_tier');
  expect(output.at(-1)).toMatchObject({ event: { type: 'response.completed', response: { usage: initialUsage, service_tier: 'fast' } } });
});

test('ChatCompletions via Messages publishes its initial role with already-known metadata', async () => {
  let pulledNext = false;
  const upstream = async function* () {
    yield eventFrame({ type: 'message_start', message: { id: 'msg_usage', model: 'served', usage: { input_tokens: 10, output_tokens: 0, speed: 'fast' } } } as any);
    pulledNext = true;
    throw new Error('The converter pulled past message_start');
  };
  const stream = openaiChatCompletionsFromIR(irFromAnthropicMessages(upstream()));
  try {
    expect((await stream.next()).value).toMatchObject({ event: { model: 'served', service_tier: 'fast', choices: [{ delta: { role: 'assistant' } }] } });
    expect(pulledNext).toBe(false);
  } finally {
    await stream.return(undefined);
  }
});

test.each([['fast', 'priority'], ['default', 'standard']])('GenerateContent maps the %s alias to its %s tier', async (tier, serviceTier) => {
  const source = fixtureFrames('openai-responses', { text: ['answer'], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, tier });
  const output = [];
  for await (const frame of geminiGenerateContentFromIR(irFromOpenAIResponses(iterate(source)))) output.push(frame);
  expect(output.at(-1)).toMatchObject({ event: { usageMetadata: { serviceTier } } });
});

test('GenerateContent rejects reasoning counts exceeding inclusive output', () => {
  expect(() => usageFromIR({ output_tokens_inclusive: 3, reasoning_tokens: 5 })).toThrow('reasoning tokens exceed inclusive output tokens');
});

test.each([
  ['ChatCompletions prompt_tokens', chatUsageToIR, { completion_tokens: 1, total_tokens: 1 }, { output_tokens_inclusive: 1, total_tokens: 1 }],
  ['ChatCompletions completion_tokens', chatUsageToIR, { prompt_tokens: 1, total_tokens: 1 }, { input_tokens_inclusive: 1, total_tokens: 1 }],
  ['ChatCompletions total_tokens', chatUsageToIR, { prompt_tokens: 1, completion_tokens: 1 }, { input_tokens_inclusive: 1, output_tokens_inclusive: 1 }],
  ['Responses input_tokens', responsesUsageToIR, { output_tokens: 1, total_tokens: 1 }, { output_tokens_inclusive: 1, total_tokens: 1 }],
  ['Responses output_tokens', responsesUsageToIR, { input_tokens: 1, total_tokens: 1 }, { input_tokens_inclusive: 1, total_tokens: 1 }],
  ['Responses total_tokens', responsesUsageToIR, { input_tokens: 1, output_tokens: 1 }, { input_tokens_inclusive: 1, output_tokens_inclusive: 1 }],
  ['Messages output_tokens', (usage: Record<string, any>) => messagesUsageToIR(usage, {}), { input_tokens: 1 }, { input_tokens_inclusive: 1 }],
] as const)('%s is omitted when the upstream does not report it', (_name, convert, usage, expected) => {
  expect(convert(usage)).toEqual(expected);
});

test('usage ignores nonstandard aliases and provider-only extensions', () => {
  expect(chatUsageToIR({ input_tokens: 11, output_tokens: 5, total_tokens: 16 } as any)).toEqual({ total_tokens: 16 });
  expect(responsesUsageToIR({ cost: 0.0002 } as any)).toEqual({});
});

test('Messages usage permits an absent input count in cumulative deltas', () => {
  expect(messagesUsageToIR({ output_tokens: 2 }, {})).toEqual({ output_tokens_inclusive: 2 });
});

test('Messages reader accepts a message_delta without usage', async () => {
  const upstream = [
    { type: 'message_start', message: { id: 'msg_sparse', model: 'served', usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ].map(event => eventFrame(event as any));
  const result = await collectIR(irFromAnthropicMessages(iterate(upstream)));
  expect(result.usage).toMatchObject({ input_tokens_inclusive: 1, output_tokens_inclusive: 0 });
});

test.each([
  ['ChatCompletions', () => chatUsageToIR({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, completion_tokens_details: { reasoning_tokens: -1 } })],
  ['Responses', () => responsesUsageToIR({ input_tokens: 1, output_tokens: 1, total_tokens: 2, output_tokens_details: { reasoning_tokens: -1 } })],
  ['Messages', () => messagesUsageToIR({ input_tokens: 1, output_tokens: 1, output_tokens_details: { thinking_tokens: -1 } }, {})],
] as const)('%s rejects invalid optional usage counters', (_name, convert) => {
  expect(convert).toThrow('must be a non-negative safe integer');
});

test.each([
  ['ChatCompletions', chatUsageFromIR],
  ['Responses', responsesUsageFromIR],
  ['Messages', messagesUsageFromIR],
  ['GenerateContent', usageFromIR],
] as const)('%s rejects invalid optional IR usage counters', (_name, convert) => {
  expect(() => convert({ input_tokens_inclusive: 1, output_tokens_inclusive: 1, reasoning_tokens: -1 })).toThrow('must be a non-negative safe integer');
});

test.each([
  ['omitted zero bucket', { cache_creation_input_tokens: 150, cache_creation: { ephemeral_1h_input_tokens: 150 } }, 150],
  ['partial breakdown', { cache_creation_input_tokens: 150, cache_creation: { ephemeral_1h_input_tokens: 30 } }, 150],
  ['explicit null breakdown', { cache_creation: null }, 100],
  ['absent breakdown', {}, 100],
] as const)('Messages late cache snapshot preserves %s semantics', async (_name, late, total) => {
  const upstream = [
    { type: 'message_start', message: { id: 'msg_cache', model: 'served', usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2, ...late } },
    { type: 'message_stop' },
  ].map(event => eventFrame(event as any));
  const result = await collectIR(irFromAnthropicMessages(iterate(upstream)));
  expect(result.usage).toMatchObject({ input_tokens_inclusive: 10 + total, output_tokens_inclusive: 2, cache_creation_input_tokens: total });
});
