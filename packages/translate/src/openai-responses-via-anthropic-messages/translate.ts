import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { RemoteImageLoader, TranslateTrip } from '../types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

// Synthetic response id generated once per trip so that downstream events
// referencing the response carry a stable id. Built fresh per call — never
// reused across attempts.
const synthesizeResponseId = (): string => `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export const translateOpenAIResponsesViaAnthropicMessages: TranslateTrip<
  OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent, AnthropicMessagesPayload, AnthropicMessagesStreamEvent,
  { fallbackMaxOutputTokens?: number; loadRemoteImage: RemoteImageLoader }
> = async (src, ctx) => {
  const responseId = synthesizeResponseId();
  // Tool-name maps are produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped custom calls and
  // flattened namespace calls recover their source OpenAI Responses identities.
  const { target, customToolNames, namespaceToolNames } = await buildTargetRequest(src, {
    fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
    loadRemoteImage: ctx.loadRemoteImage,
  });

  return {
    target,
    events: frames => translateToSourceEvents(frames, responseId, ctx.model, customToolNames, namespaceToolNames.targetToSource),
  };
};
