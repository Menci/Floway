import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { type CanonicalResponsesPayload } from '../shared/via-responses/responses-items.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateChatCompletionsViaResponses: TranslateTrip<
  ChatCompletionsPayload, ChatCompletionsStreamEvent, CanonicalResponsesPayload, ResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
