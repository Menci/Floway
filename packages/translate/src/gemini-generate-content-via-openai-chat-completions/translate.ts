import { translateToSourceEvents } from './events.ts';
import { buildRoundTripTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translateGeminiGenerateContentViaOpenAIChatCompletions: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => ({
  target: await buildRoundTripTargetRequest(src, ctx.model, ctx.assistantTurnSidecar),
  events: frames => translateToSourceEvents(frames, ctx.assistantTurnSidecar),
});
