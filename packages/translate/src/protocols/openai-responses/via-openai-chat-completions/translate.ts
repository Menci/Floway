import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../../../types.ts';
import { restoreNamespaceEvents } from '../as-source/namespace-tools.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: TranslateTrip<
  OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => {
  const { target, customToolNames, namespaceToolNames } = await buildTargetRequest(src, ctx.sidecarCodec);
  return {
    target,
    events: frames => restoreNamespaceEvents(
      translateToSourceEvents(frames, customToolNames, ctx.sidecarCodec, namespaceToolNames, target.n ?? 1),
      namespaceToolNames,
    ),
  };
};
