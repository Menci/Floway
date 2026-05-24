import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateGeminiViaResponses: TranslateTrip<
  GeminiGenerateContentRequest, GeminiStreamEvent, ResponsesPayload, ResponsesStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model),
  events: translateToSourceEvents,
});
