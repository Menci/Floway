import { translateToSourceEvents } from './events.ts';
import { buildRoundTripTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateOpenAIChatCompletionsViaOpenAIResponses: TranslateTrip<
  OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = async (src, ctx) => ({
  target: await buildRoundTripTargetRequest(src, ctx.assistantTurnSidecar),
  events: frames => translateToSourceEvents(frames, ctx.assistantTurnSidecar),
});
