import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { Translator } from '../../../types.ts';
import { rewriteContextExceededToPromptTooLong } from '../as-source/context-window-error.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translate: Translator<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => {
  try {
    const target = await buildTargetRequest(src, ctx.sidecarCodec);
    return {
      type: 'trip',
      target,
      events: frames => translateToSourceEvents(frames, ctx.sidecarCodec, target.n ?? 1),
      error: rewriteContextExceededToPromptTooLong,
    };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
