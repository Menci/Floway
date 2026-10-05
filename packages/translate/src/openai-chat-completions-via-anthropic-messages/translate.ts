import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { decodeChatPrivateHistory } from '../shared/openai-chat-completions/history.ts';
import type { OpenAIChatCompletionsPrivateTranslationContext, RemoteImageLoader, TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const translateOpenAIChatCompletionsViaAnthropicMessages: TranslateTrip<
  OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  OpenAIChatCompletionsPrivateTranslationContext & { fallbackMaxOutputTokens?: number; loadRemoteImage: RemoteImageLoader }
> = async (src, ctx) => ({
  target: await buildTargetRequest(await decodeChatPrivateHistory(src, ctx.privateContext), {
    fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    loadRemoteImage: ctx.loadRemoteImage,
  }),
  events: translateToSourceEvents,
});
