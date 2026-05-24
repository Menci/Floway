import { CHAT_COMPLETIONS_MISSING_DONE_MESSAGE } from './protocol.ts';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatReasoningItem, ChoiceNonStreaming, ToolCall } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame } from '@floway-dev/protocols/common';

const chatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ChatCompletionChunk> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

export async function reassembleChatCompletionChunks(chunks: AsyncIterable<ChatCompletionChunk>): Promise<ChatCompletionResponse> {
  let id = '';
  let model = '';
  let created = 0;
  let content = '';
  let reasoningText = '';
  let reasoningOpaque = '';
  let hasReasoningOpaque = false;
  const reasoningItems: ChatReasoningItem[] = [];
  let finishReason: ChoiceNonStreaming['finish_reason'] = 'stop';
  let lastUsage: ChatCompletionResponse['usage'] | undefined;

  const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of chunks) {
    const errorMessage = chatCompletionsErrorPayloadMessage(chunk);
    if (errorMessage) {
      throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
    }

    if (!id && chunk.id) {
      id = chunk.id as string;
      model = chunk.model as string;
      created = chunk.created as number;
    }

    if (chunk.usage) {
      lastUsage = chunk.usage as ChatCompletionResponse['usage'];
    }

    const choices = chunk.choices as unknown as Array<Record<string, unknown>> | undefined;
    if (!choices) continue;

    for (const choice of choices) {
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (typeof delta.content === 'string') {
        content += delta.content;
      }
      if (typeof delta.reasoning_text === 'string') {
        reasoningText += delta.reasoning_text;
      }
      if (typeof delta.reasoning_opaque === 'string') {
        reasoningOpaque += delta.reasoning_opaque;
        hasReasoningOpaque = true;
      }
      if (Array.isArray(delta.reasoning_items)) {
        reasoningItems.push(...(delta.reasoning_items as ChatReasoningItem[]));
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
          const idx = toolCall.index as number;
          const existing = toolCallsMap.get(idx);
          if (!existing) {
            toolCallsMap.set(idx, {
              id: (toolCall.id as string) ?? '',
              name: ((toolCall.function as Record<string, unknown>)?.name as string) ?? '',
              arguments: ((toolCall.function as Record<string, unknown>)?.arguments as string) ?? '',
            });
          } else {
            if (toolCall.id) existing.id = toolCall.id as string;
            const fn = toolCall.function as Record<string, unknown> | undefined;
            if (fn?.name) existing.name = fn.name as string;
            if (fn?.arguments) {
              existing.arguments += fn.arguments as string;
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason as ChoiceNonStreaming['finish_reason'];
      }
    }
  }

  const toolCalls: ToolCall[] = [];
  const sortedIndices = [...toolCallsMap.keys()].sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    const toolCall = toolCallsMap.get(idx)!;
    toolCalls.push({
      id: toolCall.id,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.arguments },
    });
  }

  const message: ChoiceNonStreaming['message'] = {
    role: 'assistant',
    content: content || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    ...(reasoningText && { reasoning_text: reasoningText }),
    ...(hasReasoningOpaque ? { reasoning_opaque: reasoningOpaque } : {}),
    ...(reasoningItems.length > 0 && { reasoning_items: reasoningItems }),
  };

  const result: ChatCompletionResponse = {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    ...(lastUsage && { usage: lastUsage }),
  };

  return result;
}

export const collectChatProtocolEventsToCompletion = async (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): Promise<ChatCompletionResponse> => {
  return await reassembleChatCompletionChunks(chatCompletionEventsUntilDone(frames));
};
