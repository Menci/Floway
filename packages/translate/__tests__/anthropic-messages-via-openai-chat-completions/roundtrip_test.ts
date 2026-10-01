import { expect, test } from 'vitest';

import { createOpenAIChatCompletionsToAnthropicMessagesStreamState, flushOpenAIChatCompletionsToAnthropicMessagesEvents, translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents } from '../../src/anthropic-messages-via-openai-chat-completions/events.ts';
import { buildTargetRequest } from '../../src/anthropic-messages-via-openai-chat-completions/request.ts';
import { reassembleAnthropicMessagesEvents } from '@floway-dev/protocols/anthropic-messages';
import { encodeChatCompletionsReasoningData } from '@floway-dev/protocols/openai-chat-completions';
import { flowayReasoningFields, fromFlowayOpenAIChatCompletionsReasoning, type OpenAIChatCompletionsDelta } from '@floway-dev/protocols/openai-chat-completions';

const dataByFormat = {
  'litellm-thinking-blocks': [{ type: 'thinking', thinking: 'A', signature: 'sig-A' }, { type: 'redacted_thinking', data: 'B' }, { type: 'thinking', thinking: 'C', signature: 'sig-C' }],
  'openrouter-reasoning-details': [{ type: 'reasoning.text', text: 'A', signature: 'sig-A', id: 'one', format: 'anthropic-claude-v1' }, { type: 'reasoning.encrypted', data: 'B', id: 'two', format: 'openai-responses-v1' }, { type: 'reasoning.summary', summary: 'C', id: 'three' }],
};

for (const standard of ['litellm-thinking-blocks', 'openrouter-reasoning-details'] as const) {
  for (const text of ['', 'AC']) {
    test(`${standard} keeps the complete data snapshot through Messages replay (text=${text})`, async () => {
      const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
      const chunk = (delta: OpenAIChatCompletionsDelta, finish_reason: 'stop' | null = null) => ({ id: 'c', object: 'chat.completion.chunk' as const, created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason }] });
      const partial = encodeChatCompletionsReasoningData(standard, dataByFormat[standard].slice(0, 1));
      const complete = encodeChatCompletionsReasoningData(standard, dataByFormat[standard]);
      const events = [
        ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk(flowayReasoningFields(text, partial)), state),
        ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ content: 'Answer' }), state),
        ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk(flowayReasoningFields('', complete)), state),
        ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state),
        ...flushOpenAIChatCompletionsToAnthropicMessagesEvents(state),
      ];
      const result = await reassembleAnthropicMessagesEvents((async function* () { yield* events; })());
      const replay = buildTargetRequest({ model: 'm', max_tokens: 10, messages: [{ role: 'assistant', content: result.content }] });
      const wire = fromFlowayOpenAIChatCompletionsReasoning(replay.messages[0], { text: 'reasoning', data: standard }, { warn: warning => { throw new Error(JSON.stringify(warning)); } });
      expect(wire[standard === 'litellm-thinking-blocks' ? 'thinking_blocks' : 'reasoning_details']).toEqual(dataByFormat[standard]);
      expect(wire.reasoning ?? '').toBe(text);
      expect(result.content.at(-1)).toMatchObject({ type: 'text', text: 'Answer' });
    });
  }
}
