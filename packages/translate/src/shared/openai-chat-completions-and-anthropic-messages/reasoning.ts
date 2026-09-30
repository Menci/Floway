import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';
import { decodeReasoningData } from '@floway-dev/protocols/common';
import { validateStructuredReasoning } from '@floway-dev/protocols/openai-chat-completions';

export interface OpenAIChatCompletionsScalarReasoning {
  reasoningText: string | null;
  reasoningOpaque: string | null;
}

export const anthropicMessagesThinkingBlockFromOpenAIChatCompletionsScalarReasoning = (
  reasoningText: string | null | undefined,
  reasoningOpaque: string | null | undefined,
): AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock | null => {
  if (reasoningText) {
    return {
      type: 'thinking',
      thinking: reasoningText,
      ...(reasoningOpaque !== undefined && reasoningOpaque !== null ? { signature: reasoningOpaque } : {}),
    };
  }

  return reasoningOpaque !== undefined && reasoningOpaque !== null ? { type: 'redacted_thinking', data: reasoningOpaque } : null;
};

export const openaiChatCompletionsScalarReasoningFromAnthropicMessagesBlock = (block: AnthropicMessagesAssistantContentBlock): OpenAIChatCompletionsScalarReasoning | null => {
  if (block.type === 'thinking') {
    return {
      reasoningText: block.thinking || null,
      reasoningOpaque: block.signature ?? null,
    };
  }

  return block.type === 'redacted_thinking'
    ? {
        reasoningText: null,
        reasoningOpaque: block.data,
      }
    : null;
};

export const anthropicMessagesBlocksFromChatCompletionsReasoning = (text: string | undefined, opaque: string | undefined): (AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock)[] => {
  const envelope = opaque === undefined ? undefined : decodeReasoningData(opaque);
  if (envelope?.type === 'litellm-thinking-blocks') {
    return validateStructuredReasoning(envelope.value, 'litellm-thinking-blocks').flatMap<AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock>(item => {
      if (item.type === 'redacted_thinking') return typeof item.data === 'string' ? [{ type: 'redacted_thinking' as const, data: item.data }] : [];
      return [{ type: 'thinking' as const, thinking: typeof item.thinking === 'string' ? item.thinking : '', ...(typeof item.signature === 'string' ? { signature: item.signature } : {}) }];
    });
  }
  if (envelope?.type === 'openrouter-reasoning-details') {
    return validateStructuredReasoning(envelope.value, 'openrouter-reasoning-details').flatMap<AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock>(item => {
      if (item.type === 'reasoning.encrypted') return [{ type: 'redacted_thinking' as const, data: item.data as string }];
      if (item.type === 'reasoning.text') return [{ type: 'thinking' as const, thinking: typeof item.text === 'string' ? item.text : '', ...(typeof item.signature === 'string' ? { signature: item.signature } : {}) }];
      if (item.type === 'reasoning.summary') return [{ type: 'thinking' as const, thinking: item.summary as string }];
      return [];
    });
  }
  const scalar = anthropicMessagesThinkingBlockFromOpenAIChatCompletionsScalarReasoning(text, opaque);
  return scalar === null ? [] : [scalar];
};
