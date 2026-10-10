import { translateToSourceEvents } from './events.ts';
import { buildRoundTripTargetRequest } from './request.ts';
import type { RemoteImageLoader, TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const translateOpenAIChatCompletionsViaAnthropicMessages: TranslateTrip<
  OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  { fallbackMaxOutputTokens?: number; loadRemoteImage: RemoteImageLoader }
> = async (src, ctx) => {
  const streamOptions = { ...src.stream_options };
  return {
    target: await buildRoundTripTargetRequest(src, ctx.assistantTurnSidecar, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
      loadRemoteImage: ctx.loadRemoteImage,
    }),
    events: frames => translateToSourceEvents(frames, streamOptions, ctx.assistantTurnSidecar),
  };
};
