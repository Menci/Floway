import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ResponsesRequestPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateResponsesViaChatCompletions: TranslateTrip<
  ResponsesRequestPayload, ResponsesStreamEvent, ChatCompletionsPayload, ChatCompletionsStreamEvent
> = async src => {
  // Tool-name maps are produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped custom calls and
  // flattened namespace calls recover their source Responses identities.
  const { target, customToolNames, namespaceToolNames } = buildTargetRequest(src);

  return {
    target,
    events: frames => translateToSourceEvents(frames, customToolNames, namespaceToolNames.targetToSource),
  };
};
