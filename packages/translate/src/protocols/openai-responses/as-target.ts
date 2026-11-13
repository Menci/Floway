import { readOpenAIResponsesEvents } from './as-target/events.ts';
import { openaiResponsesPayloadFromSegments } from './as-target/segmented-request.ts';
import type { TargetProtocol } from '../../composition/index.ts';
import { assignCallIds, type PendingCall } from '../../composition/request/call-ids.ts';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

type ResponsesRestoredAssistantTurn = readonly CanonicalOpenAIResponsesInputItem[];

// Responses call and result IDs accept at most 64 characters.
// https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/public/openapi/openapi.json
const RESPONSES_MAX_CALL_ID_LENGTH = 64;

const callsOf = (turn: ResponsesRestoredAssistantTurn): readonly PendingCall[] =>
  turn.flatMap(item => item.type === 'function_call' || item.type === 'custom_tool_call'
    ? [{ callId: item.call_id, name: item.name }]
    : []);

/** Restored Responses turns expose their own call IDs, and returned call items carry the IDs needed for event correlation. */
export const openaiResponsesTargetProtocol: TargetProtocol<
  'openaiResponses', CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = {
  name: 'openaiResponses',
  write: (request, turns) => ({
    payload: openaiResponsesPayloadFromSegments(request, assignCallIds(turns, callsOf, { maxGeneratedCallIdLength: RESPONSES_MAX_CALL_ID_LENGTH })),
    context: undefined,
  }),
  readEvents: (frames, _context, roundTripReader) => readOpenAIResponsesEvents(frames, { roundTrip: roundTripReader }),
};
