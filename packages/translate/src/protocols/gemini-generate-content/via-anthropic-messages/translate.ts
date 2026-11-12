import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { Translator } from '../../../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translate: Translator<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => {
  try {
    return {
      type: 'trip',
      error: () => undefined,
      target: await buildTargetRequest(src, ctx.model, ctx.sidecarCodec, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }),
      events: frames => translateToSourceEvents(frames, ctx.sidecarCodec),
    };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
