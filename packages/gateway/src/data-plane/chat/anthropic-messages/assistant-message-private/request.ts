import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPrivateCodec } from '@floway-dev/protocols/openai-chat-completions';

export const discardAnthropicMessagesChatReplay = async (payload: AnthropicMessagesPayload, codec: OpenAIChatCompletionsPrivateCodec): Promise<AnthropicMessagesPayload> => {
  const removals = new Map<number, Set<number>>();
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const removed = new Set<number>();
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'redacted_thinking') continue;
      const value = await codec.unencapsulate(block.data);
      if (value?.sidecar.upstreamProtocol === 'openaiChatCompletions') removed.add(index);
    }
    if (removed.size === 0) continue;
    for (const [index, block] of message.content.entries()) {
      if (block.type === 'thinking' && block.signature === '') removed.add(index);
    }
    removals.set(messageIndex, removed);
  }
  if (removals.size === 0) return payload;
  return {
    ...payload, messages: payload.messages.flatMap((message, messageIndex) => {
      const removed = removals.get(messageIndex);
      if (removed === undefined) return [message];
      if (message.role !== 'assistant' || !Array.isArray(message.content)) throw new Error('Chat replay removal no longer points to an assistant block array');
      const content = message.content.filter((_, index) => !removed.has(index));
      return content.length > 0 ? [{ ...message, content }] : [];
    }),
  };
};
