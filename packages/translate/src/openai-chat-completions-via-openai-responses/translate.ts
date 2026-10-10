import { translateToSourceEvents } from './events.ts';
import { buildRoundTripTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateOpenAIChatCompletionsViaOpenAIResponses: TranslateTrip<
  OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async (src, ctx) => {
  const streamOptions = { ...src.stream_options };
  return {
    target: await buildRoundTripTargetRequest(src, ctx.assistantTurnSidecar),
    events: frames => translateToSourceEvents(frames, streamOptions, ctx.assistantTurnSidecar),
  };
};
