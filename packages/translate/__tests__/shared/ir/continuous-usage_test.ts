import { expect, test } from 'vitest';

import { collect, iterate } from './helpers.ts';
import { fixtureFrames } from './translation-cases.ts';
import { translateOpenAIChatCompletionsViaAnthropicMessages } from '../../../src/openai-chat-completions-via-anthropic-messages/translate.ts';
import { translateOpenAIChatCompletionsViaOpenAIResponses } from '../../../src/openai-chat-completions-via-openai-responses/translate.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

const protocols = ['anthropic-messages', 'openai-responses'] as const;
const flags = [undefined, false, true];

test.each(protocols)('ChatCompletions via %s captures continuous usage preferences for the trip', async protocol => {
  for (const include_usage of flags) for (const continuous_usage_stats of flags) {
    const src: OpenAIChatCompletionsPayloadEx = { model: 'model', messages: [], stream: true, stream_options: { include_usage, continuous_usage_stats } };
    const trip = protocol === 'anthropic-messages'
      ? await translateOpenAIChatCompletionsViaAnthropicMessages(src, { model: 'model', fallbackMaxOutputTokens: 100, loadRemoteImage: async () => { throw new Error('Unexpected image'); } })
      : await translateOpenAIChatCompletionsViaOpenAIResponses(src, { model: 'model' });
    src.stream_options!.include_usage = include_usage !== true;
    src.stream_options!.continuous_usage_stats = continuous_usage_stats !== true;
    const usage = protocol === 'anthropic-messages' ? { input_tokens: 10, output_tokens: 4 } : { input_tokens: 10, output_tokens: 4, total_tokens: 14 };
    const frames = await collect(trip.events(iterate(fixtureFrames(protocol, { text: ['answer'], thinking: ['reason'], tools: [{ id: 'call', name: 'tool', args: { value: 1 } }], usage }))));
    const chunks = frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
    const body = chunks.filter(chunk => chunk.choices.length > 0);
    expect(body.length).toBeGreaterThan(3);
    for (const chunk of body) {
      if (include_usage === true && continuous_usage_stats === true) expect(chunk.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
      else expect(chunk).not.toHaveProperty('usage');
    }
    expect(chunks.filter(chunk => chunk.choices.length === 0)).toHaveLength(1);
  }
});

test('ChatCompletions continuous usage reflects reported Responses counters without extra progress chunks', async () => {
  const trip = await translateOpenAIChatCompletionsViaOpenAIResponses({ model: 'model', messages: [], stream_options: { include_usage: true, continuous_usage_stats: true } }, { model: 'model' });
  const response = { id: 'resp', model: 'model', created_at: 1, status: 'in_progress', output: [], usage: null };
  const frames = [
    { type: 'response.created', response },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'A' },
    { type: 'response.in_progress', response: { ...response, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'B' },
    { type: 'response.completed', response: { ...response, status: 'completed', output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'AB', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
  ];
  const output = await collect(trip.events(iterate(frames.map(event => ({ type: 'event' as const, event: event as any })))));
  const chunks = output.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
  const body = chunks.filter(chunk => chunk.choices.length > 0);
  expect(body).toHaveLength(4);
  expect(body.slice(0, 2).map(chunk => chunk.usage)).toEqual([null, null]);
  expect(body[2]).toMatchObject({ choices: [{ delta: { content: 'B' } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  expect(body[3]).toMatchObject({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
  expect(chunks.at(-1)).toMatchObject({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
});
