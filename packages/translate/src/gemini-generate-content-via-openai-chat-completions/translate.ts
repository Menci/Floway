import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { OpenAIChatCompletionsPrivateTranslationContext, TranslateTrip } from '../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentPart, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsAssistantMessagePrivate, OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translateGeminiGenerateContentViaOpenAIChatCompletions: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, Required<OpenAIChatCompletionsPrivateTranslationContext>
> = async (src, ctx) => {
  const decoded = new Map<GeminiGenerateContentPart, OpenAIChatCompletionsAssistantMessagePrivate>();
  for (const content of src.contents ?? []) {
    if (content.role !== 'model') continue;
    for (const part of content.parts ?? []) {
      const value = await ctx.privateContext.codec.unencapsulate(part.thoughtSignature);
      if (value !== undefined) decoded.set(part, value);
    }
  }
  return {
    target: buildTargetRequest(src, ctx.model, decoded),
    events: frames => translateToSourceEvents(frames, ctx.privateContext),
  };
};
