import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { decodeChatPrivateHistory } from '../shared/openai-chat-completions/history.ts';
import type { OpenAIChatCompletionsPrivateTranslationContext, TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateOpenAIChatCompletionsViaOpenAIResponses: TranslateTrip<
  OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx, OpenAIChatCompletionsPrivateTranslationContext
> = async (src, ctx) => ({
  target: buildTargetRequest(await decodeChatPrivateHistory(src, ctx.privateContext)),
  events: translateToSourceEvents,
});
