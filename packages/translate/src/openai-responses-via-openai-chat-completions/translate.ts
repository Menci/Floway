import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-openai-responses-payload.ts';
import { restoreNamespaceEvents } from '../shared/openai-responses-via/namespace-tools.ts';
import type { OpenAIChatCompletionsPrivateTranslationContext, TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsAssistantMessagePrivate } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translateOpenAIResponsesViaOpenAIChatCompletions: TranslateTrip<
  OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent, Required<OpenAIChatCompletionsPrivateTranslationContext>
> = async (src, ctx) => {
  const payload = canonicalizeOpenAIResponsesPayload(src);
  const decoded = new Map<object, OpenAIChatCompletionsAssistantMessagePrivate>();
  for (const item of payload.input) {
    if (item.type !== 'reasoning') continue;
    const privateState = await ctx.privateContext.codec.unencapsulate(item.encrypted_content);
    if (privateState !== undefined) decoded.set(item, privateState);
  }
  const { target, customToolNames, namespaceToolNames } = buildTargetRequest(payload, decoded);

  return {
    target,
    events: frames => restoreNamespaceEvents(translateToSourceEvents(frames, customToolNames, ctx.privateContext), namespaceToolNames),
  };
};
