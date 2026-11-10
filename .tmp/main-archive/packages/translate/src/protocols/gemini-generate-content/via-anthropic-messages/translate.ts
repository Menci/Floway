import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../../../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translate: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => {
  return {
    target: await buildTargetRequest(src, ctx.model, ctx.sidecarCodec, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }),
    events: frames => translateToSourceEvents(frames, ctx.sidecarCodec),
  };
};
