import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { Translator } from '../../../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: Translator<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async (src, ctx) => {
  try {
    return {
      type: 'trip',
      error: () => undefined,
      target: await buildTargetRequest(src, ctx.model, ctx.sidecarCodec),
      events: frames => translateToSourceEvents(frames, ctx.sidecarCodec),
    };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
