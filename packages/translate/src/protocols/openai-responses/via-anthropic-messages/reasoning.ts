import type { AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesReasoningItem } from '@floway-dev/protocols/openai-responses';

type AnthropicMessagesReasoningBlock = AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock;

/**
 * Project an OpenAI Responses reasoning item into an Anthropic Messages block
 * for a real upstream. The upstream owns its signature, so `encrypted_content`
 * is forwarded verbatim without packing the Responses item id into it.
 *
 * An item without opaque content has nothing the upstream can verify. We emit
 * readable thinking without a signature when text exists and omit an empty item.
 */
export const openaiResponsesReasoningToAnthropicMessagesUpstreamBlock = (item: OpenAIResponsesReasoningItem): AnthropicMessagesReasoningBlock | null => {
  const thinking = item.summary?.length
    ? item.summary
        .map(part => part.text)
        .join('')
        .trim()
    : '';

  if (!thinking) {
    return item.encrypted_content ? { type: 'redacted_thinking', data: item.encrypted_content } : null;
  }

  return { type: 'thinking', thinking, signature: item.encrypted_content ?? '' };
};
