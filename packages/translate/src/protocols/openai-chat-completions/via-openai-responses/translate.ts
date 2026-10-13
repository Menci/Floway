import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { createAssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import type { TranslateTrip } from '../../../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: TranslateTrip<
  OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async (src, ctx) => {
  const codec = createAssistantTurnSidecarCodec(ctx.serverSecret);
  const streamOptions = { ...src.stream_options };
  return {
    target: await buildTargetRequest(src, codec),
    events: frames => translateToSourceEvents(frames, streamOptions),
  };
};
