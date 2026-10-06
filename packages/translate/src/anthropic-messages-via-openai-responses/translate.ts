import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { rewriteContextExceededToPromptTooLong } from '../shared/anthropic-messages-via/context-window-error.ts';
import type { TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateAnthropicMessagesViaOpenAIResponses: TranslateTrip<
  AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
  apiError: rewriteContextExceededToPromptTooLong,
});
