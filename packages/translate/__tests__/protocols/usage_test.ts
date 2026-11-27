import { expect, test } from 'vitest';

import { fixtureFrames } from './fixtures.ts';
import { writeGeminiGenerateContentEvents, readAnthropicMessagesEvents, readGeminiGenerateContentEvents, readOpenAIChatCompletionsEvents, readOpenAIResponsesEvents, writeOpenAIResponsesEvents } from './helpers.ts';
import { usageToIR as messagesUsageToIR } from '../../src/protocols/anthropic-messages/as-target/usage.ts';
import { usageToIR as geminiUsageToIR } from '../../src/protocols/gemini-generate-content/as-target/usage.ts';
import { usageToIR as chatUsageToIR } from '../../src/protocols/openai-chat-completions/as-target/usage.ts';
import { usageToIR as responsesUsageToIR } from '../../src/protocols/openai-responses/as-target/usage.ts';
import { collectIR } from '../ir/output/helpers.ts';
import { iterate } from '../shared/iterables.ts';
import { eventFrame, FAST_SERVICE_TIER } from '@floway-dev/protocols/common';

const initialUsage = { input_tokens: 17, output_tokens: 2, total_tokens: 19, input_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 } };
const sources = [
  ['ChatCompletions', readOpenAIChatCompletionsEvents, { id: 'resp_usage', model: 'served', created: 1, choices: [], service_tier: 'priority', usage: { prompt_tokens: 17, completion_tokens: 2, total_tokens: 19, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 } } }, 'priority', initialUsage],
  ['Responses', readOpenAIResponsesEvents, { type: 'response.created', response: { id: 'resp_usage', model: 'served', created_at: 1, status: 'in_progress', output: [], service_tier: 'fast', usage: initialUsage } }, 'fast', initialUsage],
  ['Messages', readAnthropicMessagesEvents, { type: 'message_start', message: { id: 'msg_usage', model: 'served', usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, speed: 'fast' } } }, 'fast', initialUsage],
  ['GenerateContent', readGeminiGenerateContentEvents, { responseId: 'resp_usage', modelVersion: 'served', usageMetadata: { promptTokenCount: 17, cachedContentTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 19, serviceTier: FAST_SERVICE_TIER } }, 'priority', { input_tokens: 17, output_tokens: 2, total_tokens: 19, input_tokens_details: { cached_tokens: 3 } }],
] as const;

test.each(sources)('Responses via %s exposes known initial accounting before pulling another upstream frame', async (_name, reader, event, tier, expectedUsage) => {
  let pulledNext = false;
  const upstream = async function* () {
    yield eventFrame(event as any);
    pulledNext = true;
    throw new Error('The converter pulled past the initial upstream frame');
  };
  const stream = writeOpenAIResponsesEvents(reader(upstream()));
  try {
    for (const type of ['response.created', 'response.in_progress']) {
      const frame = (await stream.next()).value;
      expect(frame).toMatchObject({ type: 'event', event: { type, response: { model: 'served', service_tier: tier, usage: expectedUsage } } });
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
  for await (const frame of writeOpenAIResponsesEvents(readOpenAIResponsesEvents(iterate(upstream)))) output.push(frame);
  expect(output[0]).toMatchObject({ event: { response: { usage: null } } });
  expect(output[0].type === 'event' && output[0].event.type === 'response.created' && output[0].event.response).not.toHaveProperty('service_tier');
  expect(output.at(-1)).toMatchObject({ event: { type: 'response.completed', response: { usage: initialUsage, service_tier: 'fast' } } });
});

test.each([['default', 'standard']])('GenerateContent maps the %s alias to its %s tier', async (tier, serviceTier) => {
  const source = fixtureFrames('openai-responses', { text: ['answer'], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, tier });
  const output = [];
  for await (const frame of writeGeminiGenerateContentEvents(readOpenAIResponsesEvents(iterate(source)))) output.push(frame);
  expect(output.at(-1)).toMatchObject({ event: { usageMetadata: { serviceTier } } });
});

test.each([
  ['ChatCompletions prompt_tokens', chatUsageToIR, { completion_tokens: 1, total_tokens: 1 }, { output_tokens_inclusive: 1, total_tokens: 1 }],
  ['Responses total_tokens', responsesUsageToIR, { input_tokens: 1, output_tokens: 1 }, { input_tokens_inclusive: 1, output_tokens_inclusive: 1 }],
  ['Messages output_tokens', (usage: Record<string, any>) => messagesUsageToIR(usage, {}), { input_tokens: 1 }, { input_tokens_inclusive: 1 }],
  ['GenerateContent null and omitted fields', (usage: Record<string, any>) => geminiUsageToIR(usage), { promptTokenCount: 1, thoughtsTokenCount: null as never, cachedContentTokenCount: null as never, promptTokensDetails: [{ modality: 'toString', tokenCount: 5 }] }, { input_tokens_inclusive: 1 }],
] as const)('%s is omitted when the upstream does not report it', (_name, convert, usage, expected) => {
  expect(convert(usage)).toEqual(expected);
});

test('GenerateContent retains prior usage counts and modality details across partial or empty-array late usageMetadata snapshots', async () => {
  const upstream = [
    {
      modelVersion: 'served',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ thought: true, text: 'think' }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 80,
        thoughtsTokenCount: 40,
        candidatesTokenCount: 0,
        promptTokensDetails: [{ modality: 'TEXT', tokenCount: 100 }],
      },
    },
    {
      modelVersion: 'served',
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { candidatesTokenCount: 20, promptTokensDetails: [] },
    },
  ].map(event => eventFrame(event as any));
  const result = await collectIR(readGeminiGenerateContentEvents(iterate(upstream)));
  expect(result.usage).toEqual({
    input_tokens_inclusive: 100,
    cached_input_tokens: 80,
    output_tokens_inclusive: 60,
    reasoning_tokens: 40,
    input_text_tokens: 100,
  });
  expect(() => geminiUsageToIR({ promptTokenCount: 4, cachedContentTokenCount: 5 })).toThrow(RangeError);
});

test.each([
  ['partial breakdown', { cache_creation_input_tokens: 150, cache_creation: { ephemeral_1h_input_tokens: 30 } }, 150],
  ['explicit null breakdown', { cache_creation: null }, 100],
] as const)('Messages late cache snapshot preserves %s semantics', async (_name, late, total) => {
  const upstream = [
    { type: 'message_start', message: { id: 'msg_cache', model: 'served', usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2, ...late } },
    { type: 'message_stop' },
  ].map(event => eventFrame(event as any));
  const result = await collectIR(readAnthropicMessagesEvents(iterate(upstream)));
  expect(result.usage).toMatchObject({ input_tokens_inclusive: 10 + total, output_tokens_inclusive: 2, cache_creation_input_tokens: total });
});
