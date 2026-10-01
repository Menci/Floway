import { klona } from 'klona/json';

import type { AnthropicMessagesThinkingBlock, AnthropicMessagesRedactedThinkingBlock } from '@floway-dev/protocols/anthropic-messages';
import { decodeChatCompletionsReasoningData, openAIChatCompletionsReasoningOpaque, validateStructuredReasoning, type FlowayOpenAIChatCompletionsReasoningCarrier } from '@floway-dev/protocols/openai-chat-completions';

export const thinkingBlocksFromChatCompletions = (message: FlowayOpenAIChatCompletionsReasoningCarrier): (AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock)[] | undefined => {
  const opaque = openAIChatCompletionsReasoningOpaque(message);
  if (opaque === undefined) return undefined;
  const envelope = decodeChatCompletionsReasoningData(opaque);
  if (envelope?.type !== 'litellm-thinking-blocks') {
    if (envelope !== undefined) console.warn('Floway ignored Chat Completions reasoning data for Messages:', { expected: 'litellm-thinking-blocks', received: envelope.type });
    return undefined;
  }
  const blocks = validateStructuredReasoning(envelope.value, 'litellm-thinking-blocks');
  // LiteLLM omits thinking that Anthropic cannot accept on replay.
  // https://github.com/BerriAI/litellm/blob/0980f756bd031993329eb0b8b2caa193047e6465/litellm/litellm_core_utils/prompt_templates/common_utils.py#L1992-L2014
  return blocks.flatMap<AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock>(block => {
    if (block.type === 'redacted_thinking') {
      if (typeof block.data !== 'string') throw new TypeError('Malformed LiteLLM redacted thinking data');
      return [klona({ ...block, type: 'redacted_thinking', data: block.data })];
    }
    if (typeof block.thinking !== 'string' || block.thinking.trim() === '' || typeof block.signature !== 'string' || block.signature === '') return [];
    return [klona({ ...block, type: 'thinking', thinking: block.thinking, signature: block.signature })];
  });
};
