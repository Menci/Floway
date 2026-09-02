import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translateGeminiGenerateContentViaAnthropicMessages: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEvent,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }),
  events: translateToSourceEvents,
});
