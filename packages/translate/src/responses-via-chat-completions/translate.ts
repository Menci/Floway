import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ResponsesRequestPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateResponsesViaChatCompletions: TranslateTrip<
  ResponsesRequestPayload, ResponsesStreamEvent, ChatCompletionsPayload, ChatCompletionsStreamEvent
> = async src => {
  // customToolNames is produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped function calls
  // can be projected back into `custom_tool_call` outputs.
  const { target, customToolNames } = buildTargetRequest(src);

  return {
    target,
    events: frames => translateToSourceEvents(frames, customToolNames),
  };
};
