import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { createAssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import type { TranslateTrip } from '../../../types.ts';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translate: TranslateTrip<
  GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => {
  const codec = createAssistantTurnSidecarCodec(ctx.serverSecret);
  const target = await buildTargetRequest(src, ctx.model, codec);
  return { target, events: frames => translateToSourceEvents(frames, target.n ?? 1) };
};
