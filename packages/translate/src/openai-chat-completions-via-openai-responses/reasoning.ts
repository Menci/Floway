import { klona } from 'klona/json';

import { decodeChatCompletionsReasoningData, openAIChatCompletionsReasoningOpaque, type OpenAIChatCompletionsReasoningItem, type FlowayOpenAIChatCompletionsReasoningCarrier } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesInputReasoning, OpenAIResponsesOutputReasoning } from '@floway-dev/protocols/openai-responses';

// Match LiteLLM's reasoning_items sidecar, including its field projection.
// https://github.com/BerriAI/litellm/blob/0980f756bd031993329eb0b8b2caa193047e6465/litellm/completion_extras/litellm_responses_transformation/transformation.py#L135-L178
export const chatCompletionsReasoningItemFromResponses = (item: OpenAIResponsesOutputReasoning): OpenAIChatCompletionsReasoningItem => ({
  type: 'reasoning',
  id: item.id,
  summary: item.summary.map(part => ({ type: part.type, text: part.text })),
  encrypted_content: item.encrypted_content ?? null,
});

export const openAIChatCompletionsReasoningItems = (message: FlowayOpenAIChatCompletionsReasoningCarrier): OpenAIResponsesInputReasoning[] => {
  const opaque = openAIChatCompletionsReasoningOpaque(message);
  if (opaque === undefined) return [];
  const envelope = decodeChatCompletionsReasoningData(opaque);
  if (envelope?.type !== 'litellm-reasoning-items') {
    if (envelope !== undefined) console.warn('Floway ignored Chat Completions reasoning data for Responses:', { expected: 'litellm-reasoning-items', received: envelope.type });
    return [];
  }
  if (!Array.isArray(envelope.value) || envelope.value.some((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return true;
    const fields = item as Record<string, unknown>;
    if (fields.type !== 'reasoning' || typeof fields.id !== 'string' || !Array.isArray(fields.summary)) return true;
    if (fields.encrypted_content != null && typeof fields.encrypted_content !== 'string') return true;
    return fields.summary.some((part: unknown) => typeof part !== 'object' || part === null || Array.isArray(part) || !('type' in part) || part.type !== 'summary_text' || !('text' in part) || typeof part.text !== 'string');
  })) throw new TypeError('Malformed LiteLLM reasoning items');
  // Stored items supply reasoning; scalar text does not participate in replay.
  // https://github.com/BerriAI/litellm/blob/0980f756bd031993329eb0b8b2caa193047e6465/litellm/completion_extras/litellm_responses_transformation/transformation.py#L119-L132
  return envelope.value.map(item => ({
    type: 'reasoning',
    id: item.id,
    summary: klona(item.summary),
    ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
  }));
};
