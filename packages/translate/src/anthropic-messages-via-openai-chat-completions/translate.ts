import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { rewriteContextExceededToPromptTooLong } from '../shared/anthropic-messages-via/context-window-error.ts';
import type { OpenAIChatCompletionsPrivateTranslationContext, TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsAssistantMessagePrivate } from '@floway-dev/protocols/openai-chat-completions';

export const translateAnthropicMessagesViaOpenAIChatCompletions: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, Required<OpenAIChatCompletionsPrivateTranslationContext>
> = async (src, ctx) => {
  const decoded = new Map<object, OpenAIChatCompletionsAssistantMessagePrivate>();
  for (const message of src.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'redacted_thinking') continue;
      const privateState = await ctx.privateContext.codec.unencapsulate(block.data);
      if (privateState === undefined) continue;
      decoded.set(message, privateState);
      break;
    }
  }
  return {
    target: buildTargetRequest(src, decoded),
    events: frames => translateToSourceEvents(frames, ctx.privateContext),
    apiError: rewriteContextExceededToPromptTooLong,
  };
};
