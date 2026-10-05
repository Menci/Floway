import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { decodeGeminiGenerateContentPrivateHistory, wrapGeminiGenerateContentNativePrivateEvents } from '../shared/gemini-generate-content-via/assistant-message-private.ts';
import { createOpenAIResponsesPrivateState, observeOpenAIResponsesPrivate, finalizeOpenAIResponsesPrivate } from '../shared/via-openai-responses/assistant-message-private.ts';
import type { OpenAIChatCompletionsPrivateTranslationContext, TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateGeminiGenerateContentViaOpenAIResponses: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx, Required<OpenAIChatCompletionsPrivateTranslationContext>
> = async (src, ctx) => {
  const decoded = await decodeGeminiGenerateContentPrivateHistory(src, ctx.privateContext.codec);
  return {
    target: buildTargetRequest(src, ctx.model, decoded),
    events: frames => {
      const state = createOpenAIResponsesPrivateState();
      return wrapGeminiGenerateContentNativePrivateEvents(frames, translateToSourceEvents, event => observeOpenAIResponsesPrivate(event, state), () => finalizeOpenAIResponsesPrivate(state), ctx.privateContext.codec);
    },
  };
};
