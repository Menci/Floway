import type { OpenAIChatCompletionsPrivateCodec } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const discardOpenAIResponsesChatReplay = async (payload: CanonicalOpenAIResponsesPayload, codec: OpenAIChatCompletionsPrivateCodec): Promise<CanonicalOpenAIResponsesPayload> => {
  const removed = new Set<number>();
  let readableReasoning: number[] = [];
  for (const [index, item] of payload.input.entries()) {
    if (item.type === 'reasoning') {
      const value = await codec.unencapsulate(item.encrypted_content);
      if (value?.sidecar.upstreamProtocol === 'openaiChatCompletions') {
        removed.add(index);
        for (const readable of readableReasoning) removed.add(readable);
        readableReasoning = [];
      } else if (item.encrypted_content == null) readableReasoning.push(index);
      continue;
    }
    if (item.type === 'function_call' || item.type === 'custom_tool_call' || (item.type === 'message' && item.role === 'assistant')) continue;
    readableReasoning = [];
  }
  return removed.size > 0 ? { ...payload, input: payload.input.filter((_, index) => !removed.has(index)) } : payload;
};
