import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { rewriteContextExceededToPromptTooLong } from '../shared/anthropic-messages-via/context-window-error.ts';
import type { TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';

export const translateAnthropicMessagesViaOpenAIChatCompletions: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
  apiError: rewriteContextExceededToPromptTooLong,
});
