import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import { restoreNamespaceEvents } from '../shared/openai-responses-via/namespace-tools.ts';
import type { TranslateTrip } from '../types.ts';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

export const translateOpenAIResponsesViaOpenAIChatCompletions: TranslateTrip<
  OpenAIResponsesRequestPayload, OpenAIResponsesStreamEvent, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent
> = async src => {
  // customToolNames is produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped function calls
  // can be projected back into `custom_tool_call` outputs.
  const { target, customToolNames, namespaceToolNames } = buildTargetRequest(src);

  return {
    target,
    events: frames => restoreNamespaceEvents(translateToSourceEvents(frames, customToolNames), namespaceToolNames.targetToSource),
  };
};
