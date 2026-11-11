import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { RemoteImageLoader, Translator } from '../../../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const translate: Translator<
  OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  { fallbackMaxOutputTokens?: number; loadRemoteImage: RemoteImageLoader }
> = async (src, ctx) => {
  try {
    const streamOptions = { ...src.stream_options };
    return {
      type: 'trip',
      error: () => undefined,
      target: await buildTargetRequest(src, ctx.sidecarCodec, {
        fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
        loadRemoteImage: ctx.loadRemoteImage,
      }),
      events: frames => translateToSourceEvents(frames, streamOptions, ctx.sidecarCodec),
    };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
