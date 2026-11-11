import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type { Translator } from '../../../types.ts';
import { restateOpenAIResponsesError } from '../as-source/error-body.ts';
import { restoreNamespaceEvents } from '../as-source/namespace-tools.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export const translate: Translator<
  OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async (src, ctx) => {
  try {
    const { target, customToolNames, namespaceToolNames } = await buildTargetRequest(src, ctx.sidecarCodec);
    return {
      type: 'trip',
      error: restateOpenAIResponsesError,
      target,
      events: frames => restoreNamespaceEvents(
        translateToSourceEvents(frames, customToolNames, ctx.sidecarCodec, namespaceToolNames),
        namespaceToolNames,
      ),
    };
  } catch (error) {
    if (error instanceof TranslateInputException) return error.failure;
    throw error;
  }
};
