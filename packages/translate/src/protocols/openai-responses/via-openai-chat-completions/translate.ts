import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { createAssistantTurnSidecarCodec } from '../../../round-trip/codec.ts';
import type { TranslateTrip } from '../../../types.ts';
import { restoreNamespaceEvents } from '../as-source/namespace-tools.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: TranslateTrip<
  OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => {
  const codec = createAssistantTurnSidecarCodec(ctx.serverSecret);
  const { target, customToolNames, namespaceToolNames } = await buildTargetRequest(src, codec);
  return {
    target,
    events: frames => restoreNamespaceEvents(
      translateToSourceEvents(frames, customToolNames, target.n ?? 1),
      namespaceToolNames,
    ),
  };
};
