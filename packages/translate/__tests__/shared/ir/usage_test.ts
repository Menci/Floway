import { expect, test } from 'vitest';

import { collectIR, iterate } from './helpers.ts';
import { fixtureFrames } from './translation-cases.ts';
import { usageFromIR } from '../../../src/shared/ir/shared/usage.ts';
import { irFromAnthropicMessages } from '../../../src/shared/ir/sse-from/anthropic-messages/index.ts';
import { irFromOpenAIChatCompletions } from '../../../src/shared/ir/sse-from/openai-chat-completions/index.ts';
import { irFromOpenAIResponses } from '../../../src/shared/ir/sse-from/openai-responses/index.ts';
import { geminiGenerateContentFromIR } from '../../../src/shared/ir/sse-to/gemini-generatecontent/index.ts';
import { openaiResponsesFromIR } from '../../../src/shared/ir/sse-to/openai-responses/index.ts';
import { eventFrame } from '@floway-dev/protocols/common';

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

test.each([['fast', 'priority'], ['default', 'standard']])('GenerateContent maps the %s alias to its %s tier', async (tier, serviceTier) => {
  const source = fixtureFrames('openai-responses', { text: ['answer'], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, tier });
  const output = [];
  for await (const frame of geminiGenerateContentFromIR(irFromOpenAIResponses(iterate(source)))) output.push(frame);
  expect(output.at(-1)).toMatchObject({ event: { usageMetadata: { serviceTier } } });
});

test('GenerateContent rejects reasoning counts exceeding inclusive output', () => {
  expect(() => usageFromIR({ output_tokens_inclusive: 3, reasoning_tokens: 5 }, 'geminiGenerateContent')).toThrow('reasoning tokens exceed inclusive output tokens');
});

test.each([
  ['omitted zero bucket', { cache_creation_input_tokens: 150, cache_creation: { ephemeral_1h_input_tokens: 150 } }, { ephemeral_1h_input_tokens: 150 }, 150],
  ['partial breakdown', { cache_creation_input_tokens: 150, cache_creation: { ephemeral_1h_input_tokens: 30 } }, { ephemeral_1h_input_tokens: 30 }, 150],
  ['explicit null breakdown', { cache_creation: null }, null, 100],
  ['absent breakdown', {}, { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 }, 100],
] as const)('Messages late cache snapshot preserves %s semantics', async (_name, late, breakdown, total) => {
  const upstream = [
    { type: 'message_start', message: { id: 'msg_cache', model: 'served', usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2, ...late } },
    { type: 'message_stop' },
  ].map(event => eventFrame(event as any));
  const result = await collectIR(irFromAnthropicMessages(iterate(upstream)));
  expect(result.extensions?.anthropicMessages?.usage).toMatchObject({ cache_creation: breakdown });
  expect(result.usage).toMatchObject({ input_tokens_inclusive: 10 + total, output_tokens_inclusive: 2, cache_creation_input_tokens: total });
});
