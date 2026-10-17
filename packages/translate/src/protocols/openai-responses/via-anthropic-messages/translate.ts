import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { RemoteImageLoader, TranslateTrip } from '../../../types.ts';
import { restoreNamespaceEvents } from '../as-source/namespace-tools.ts';
import { createRandomOpenAIResponsesResponseId } from '../as-source/response-id.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: TranslateTrip<
  OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx,
  { fallbackMaxOutputTokens?: number; loadRemoteImage: RemoteImageLoader }
> = async (src, ctx) => {
  const responseId = createRandomOpenAIResponsesResponseId();
  // Tool-name maps are produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped custom calls and
  // flattened namespace calls recover their source OpenAI Responses identities.
  const { target, customToolNames, namespaceToolNames } = await buildTargetRequest(src, ctx.sidecarCodec, {
    fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    loadRemoteImage: ctx.loadRemoteImage,
  });

  return {
    target,
    events: frames => restoreNamespaceEvents(translateToSourceEvents(frames, responseId, customToolNames, ctx.sidecarCodec, namespaceToolNames), namespaceToolNames),
  };
};
