import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { decodeGeminiGenerateContentPrivateHistory, wrapGeminiGenerateContentNativePrivateEvents } from '../shared/gemini-generate-content-via/assistant-message-private.ts';
import { createAnthropicMessagesPrivateState, observeAnthropicMessagesPrivate, finalizeAnthropicMessagesPrivate } from '../shared/via-anthropic-messages/assistant-message-private.ts';
import type { OpenAIChatCompletionsPrivateTranslationContext, TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const translateGeminiGenerateContentViaAnthropicMessages: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  Required<OpenAIChatCompletionsPrivateTranslationContext> & { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => {
  const decoded = await decodeGeminiGenerateContentPrivateHistory(src, ctx.privateContext.codec);
  return {
    target: buildTargetRequest(src, ctx.model, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }, decoded),
    events: frames => {
      const state = createAnthropicMessagesPrivateState();
      return wrapGeminiGenerateContentNativePrivateEvents(frames, translateToSourceEvents, event => {
        const text = observeAnthropicMessagesPrivate(event, state);
        return text === undefined ? [] : [text];
      }, () => finalizeAnthropicMessagesPrivate(state), ctx.privateContext.codec);
    },
  };
};
