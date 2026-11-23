import { expect, test } from 'vitest';

import { copilotPipelines } from '../../../src/pipelines.ts';
import { MAX_CONSECUTIVE_WHITESPACE } from '../../../src/stages/shared/whitespace-overflow.ts';
import { fakeCopilotWire, invokeModel } from '../../pipeline-fixture.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, sseResponse } from '@floway-dev/test-utils';

const chunk = (toolCalls: NonNullable<OpenAIChatCompletionsStreamEvent['choices'][number]['delta']['tool_calls']>): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
});

const runWith = async (events: OpenAIChatCompletionsStreamEvent[]) => {
  const { model, fetcher } = await fakeCopilotWire('/chat/completions', 'gpt-test', () => sseResponse(
    `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')  }data: [DONE]\n\n`,
  ));
  return await invokeModel(copilotPipelines.openaiChatCompletions, model, { messages: [] }, fetcher);
};

test('throws when whitespace exceeds the threshold', async () => {
  await expect(runWith([
    chunk([{ index: 0, id: 'call_1', type: 'function', function: { name: 'noop', arguments: '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE + 1) } }]),
    chunk([{ index: 0, function: { arguments: '\n\n\n' } }]),
  ])).rejects.toThrow(/whitespace/i);
});

test('tracks whitespace per tool-call index independently', async () => {
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const event = chunk([
    { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: args } },
    { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: args } },
  ]);
  const result = await runWith([event]);
  assertEquals(result.events, [eventFrame(event), doneFrame()]);
});
