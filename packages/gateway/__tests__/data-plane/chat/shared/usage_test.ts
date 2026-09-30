import { expect, test } from 'vitest';

import { createAnthropicMessagesBillableUsageReader } from '../../../../src/data-plane/chat/anthropic-messages/usage.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../../../../src/data-plane/chat/openai-chat-completions/usage.ts';
import { billableUsageFromOpenAIResponsesResult } from '../../../../src/data-plane/chat/openai-responses/usage.ts';
import { chatUsageMeasurement } from '../../../../src/data-plane/chat/shared/usage.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

for (const protocol of ['openaiChatCompletions', 'anthropicMessages', 'openaiResponses'] as const) test(`${protocol} preserves reported zero input and output as measured quantities`, () => {
  const usage = protocol === 'openaiChatCompletions'
    ? billableUsageFromOpenAIChatCompletionsEvent({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })
    : protocol === 'openaiResponses'
      ? billableUsageFromOpenAIResponsesResult({ usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })
      : createAnthropicMessagesBillableUsageReader()({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  if (usage === null) throw new Error('A reported zero usage block must remain a measurement');
  expect(chatUsageMeasurement(usage)).toEqual({ quantities: { input_tokens: '0', output_tokens: '0' }, pricingFacts: { inputTokens: 0 }, dumpTokenUsage: { input: 0, output: 0 } });
});

test('absent native usage remains absent rather than reporting zero', () => {
  const chunk: OpenAIChatCompletionsStreamEvent = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [] };
  expect(billableUsageFromOpenAIChatCompletionsEvent(chunk)).toBeNull();
  expect(billableUsageFromOpenAIResponsesResult({})).toBeNull();
  expect(createAnthropicMessagesBillableUsageReader()({ type: 'message_stop' })).toBeNull();
});

test('Messages partial input accounting preserves zero without manufacturing unreported output', () => {
  const usage = createAnthropicMessagesBillableUsageReader()({ type: 'message_start', message: { usage: { input_tokens: 0 } } } as AnthropicMessagesStreamEvent);
  if (usage === null) throw new Error('Reported input must remain measurable');
  expect(chatUsageMeasurement(usage)).toEqual({ quantities: { input_tokens: '0' }, pricingFacts: { inputTokens: 0 }, dumpTokenUsage: { input: 0 } });
});

test('Messages partial output accounting preserves zero without manufacturing input or its pricing selector', () => {
  const usage = createAnthropicMessagesBillableUsageReader()({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
  if (usage === null) throw new Error('Reported output must remain measurable');
  expect(chatUsageMeasurement(usage)).toEqual({ quantities: { output_tokens: '0' }, pricingFacts: {}, dumpTokenUsage: { output: 0 } });
});
