import { translateToSourceEvents } from './events.ts';
import { buildRoundTripTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translateGeminiGenerateContentViaAnthropicMessages: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => ({
  target: await buildRoundTripTargetRequest(src, ctx.model, ctx.assistantTurnSidecar, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }),
  events: frames => translateToSourceEvents(frames, ctx.assistantTurnSidecar),
});
