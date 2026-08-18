import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { RemoteImageLoader, TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';

export const translateOpenAIChatCompletionsViaAnthropicMessages: TranslateTrip<
  OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEvent,
  { fallbackMaxOutputTokens?: number; loadRemoteImage: RemoteImageLoader }
> = async (src, ctx) => ({
  target: await buildTargetRequest(src, {
    fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    loadRemoteImage: ctx.loadRemoteImage,
  }),
  events: translateToSourceEvents,
});
