import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

export const translateOpenAIChatCompletionsViaOpenAIResponses: TranslateTrip<
  OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
