import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { type CanonicalResponsesPayload } from '../shared/via-responses/responses-items.ts';
import type { TranslateTrip } from '../types.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateMessagesViaResponses: TranslateTrip<
  MessagesPayload, MessagesStreamEvent, CanonicalResponsesPayload, ResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
