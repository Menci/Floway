import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { createAssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import type { RemoteImageLoader, TranslateTrip } from '../../../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const translate: TranslateTrip<
  OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  { fallbackMaxOutputTokens?: number; loadRemoteImage: RemoteImageLoader }
> = async (src, ctx) => {
  const codec = createAssistantTurnSidecarCodec(ctx.serverSecret);
  const streamOptions = { ...src.stream_options };
  return {
    target: await buildTargetRequest(src, codec, {
      fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
      loadRemoteImage: ctx.loadRemoteImage,
    }),
    events: frames => translateToSourceEvents(frames, streamOptions),
  };
};
