import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

export const translateGeminiGenerateContentViaOpenAIResponses: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model),
  events: translateToSourceEvents,
});
