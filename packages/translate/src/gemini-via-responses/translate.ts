import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { type CanonicalResponsesPayload } from '../shared/via-responses/responses-items.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateGeminiViaResponses: TranslateTrip<
  GeminiPayload, GeminiStreamEvent, CanonicalResponsesPayload, ResponsesStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model),
  events: translateToSourceEvents,
});
