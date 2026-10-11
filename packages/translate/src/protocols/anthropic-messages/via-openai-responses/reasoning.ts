import type { AnthropicMessagesRedactedThinkingBlock, AnthropicMessagesThinkingBlock } from '@floway-dev/protocols/anthropic-messages';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesInputReasoning } from '@floway-dev/protocols/openai-responses';

type AnthropicMessagesReasoningBlock = AnthropicMessagesThinkingBlock | AnthropicMessagesRedactedThinkingBlock;

/**
 * Pack an OpenAI Responses reasoning item's `id` and `encrypted_content` into an
 * Anthropic Messages client carrier using `${encrypted_content}@${id}`. This preserves
 * the item id that the Responses upstream binds to its opaque reasoning blob.
 *
 * `encryptedContent` may be empty when a reasoning item has an id but no opaque
 * content, so `@rs_abc` is a valid carrier.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-translation.ts#L427-L440
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-translation.ts#L565
 * - https://github.com/caozhiyuan/copilot-api/blob/79b9f491aad13259cb27e8a82faf690474b159a4/src/routes/messages/responses-stream-translation.ts#L237
 * - https://github.com/caozhiyuan/copilot-api/issues/63
 * - https://github.com/caozhiyuan/copilot-api/issues/73
 */
export const packReasoningSignature = (id: string, encryptedContent: string): string => `${encryptedContent}@${id}`;

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
