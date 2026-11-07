import type { TargetProtocol } from '../composition.ts';
import { openaiResponsesPayloadFromSegments } from './as-target/segmented-request.ts';
import { irFromOpenAIResponses } from './as-target/sse-from.ts';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

type ResponsesResolvedTurn = readonly CanonicalOpenAIResponsesInputItem[];

const callsOf = (turn: ResponsesResolvedTurn): readonly { callId: string; name: string }[] =>
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
  resolvedCalls: callsOf,
  write: (request, pieces) => Promise.resolve(openaiResponsesPayloadFromSegments(request, pieces, turn => turn)),
  readStream: (frames, reader) => irFromOpenAIResponses(frames, { roundTrip: reader }),
};
