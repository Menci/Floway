import { assignCallIds, type PendingCall } from '../composition/call-ids.ts';
import type { TargetProtocol } from '../composition.ts';
import { openaiResponsesPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromOpenAIResponses } from './as-target/sse-from.ts';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

type ResponsesResolvedTurn = readonly CanonicalOpenAIResponsesInputItem[];

const callsOf = (turn: ResponsesResolvedTurn): readonly PendingCall[] =>
  turn.flatMap(item => item.type === 'function_call' || item.type === 'custom_tool_call'
    ? [{ callId: item.call_id, name: item.name }]
    : []);

/**
 * Responses written as the side a request goes to.
 *
 * A resolved turn is a run of Responses input items, and the calls it states
 * are the call items inside it. Responses states a result's call id on the
 * result itself, so reading a stream needs nothing from the request.
 */
export const openaiResponsesTargetProtocol: TargetProtocol<
  'openaiResponses', CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx
> = {
  name: 'openaiResponses',
  write: (request, turns) => ({
    payload: openaiResponsesPayloadFromSegments(request, assignCallIds(turns, callsOf)),
    // This wire states the call id on the result itself, so reading an answer
    // needs nothing beside the payload.
    context: undefined,
  }),
  readStream: (frames, _context, roundTripReader) => irFromOpenAIResponses(frames, { roundTrip: roundTripReader }),
};
