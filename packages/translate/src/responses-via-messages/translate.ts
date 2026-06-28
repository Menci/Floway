import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Synthetic response id generated once per trip so that downstream events
// referencing the response carry a stable id. Built fresh per call — never
// reused across attempts.
const synthesizeResponseId = (): string => `resp_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export const translateResponsesViaMessages: TranslateTrip<
  ResponsesPayload, ResponsesStreamEvent, MessagesPayload, MessagesStreamEvent,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => {
  const responseId = synthesizeResponseId();
  // customToolNames is produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped function calls
  // can be projected back into `custom_tool_call` outputs.
  const { target, customToolNames } = await buildTargetRequest(src, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens });

  return {
    target,
    events: frames => translateToSourceEvents(frames, responseId, ctx.model, customToolNames),
  };
};
