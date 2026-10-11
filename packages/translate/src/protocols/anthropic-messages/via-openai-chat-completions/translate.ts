import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../../../types.ts';
import { rewriteContextExceededToPromptTooLong } from '../as-source/context-window-error.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translate: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
  apiError: rewriteContextExceededToPromptTooLong,
});
