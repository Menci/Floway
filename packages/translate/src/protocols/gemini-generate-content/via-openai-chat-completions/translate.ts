import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { Translator } from '../../../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translate: Translator<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => {
  try {
    const target = await buildTargetRequest(src, ctx.model, ctx.sidecarCodec);
    return { type: 'trip', error: () => undefined, target, events: frames => translateToSourceEvents(frames, ctx.sidecarCodec) };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
