import type { AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';

type AnthropicMessagesReasoningBlock = AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock;

const unpackReasoningSignature = (signature: string): { id: string | null; encryptedContent: string } => {
  const splitIndex = signature.lastIndexOf('@');
  if (splitIndex === -1 || splitIndex === signature.length - 1) {
    return { id: null, encryptedContent: signature };
  }
  return { id: signature.slice(splitIndex + 1), encryptedContent: signature.slice(0, splitIndex) };
};

/**
 * Project a reasoning carrier echoed by an Anthropic Messages client into an
 * OpenAI Responses reasoning item. Genuine Anthropic signatures contain no
 * carrier id and remain unchanged while the item gets a fresh Responses id.
 */
export const anthropicMessagesReasoningBlockToOpenAIResponsesReasoning = (block: AnthropicMessagesReasoningBlock): OpenAIResponsesInputReasoning => {
  const carrier = block.type === 'thinking' ? block.signature : block.data;
  const { id, encryptedContent } = carrier ? unpackReasoningSignature(carrier) : { id: null, encryptedContent: undefined };
  const summary = block.type === 'thinking' && block.thinking ? [{ type: 'summary_text' as const, text: block.thinking }] : [];

  return {
    type: 'reasoning',
    id: id ?? createRandomOpenAIResponsesItemId('reasoning'),
    summary,
    ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
  };
};
