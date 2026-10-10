import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateOpenAIChatCompletionsViaOpenAIResponses: TranslateTrip<
  OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async src => {
  const streamOptions = { ...src.stream_options };
  return {
    target: buildTargetRequest(src),
    events: frames => translateToSourceEvents(frames, streamOptions),
  };
};
