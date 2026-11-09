import type { SourceProtocol } from '../composition.ts';
import { openaiResponsesErrorWriter } from './as-source/error-body.ts';
import { groupedCallNamesFromIR } from './as-source/grouped-calls.ts';
import { openaiResponsesRead } from './as-source/input-to.ts';
import { createRandomOpenAIResponsesResponseId } from './as-source/response-id.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from './as-source/round-trip.ts';
import { openaiResponsesFromIR } from './as-source/sse-to.ts';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

/**
 * OpenAI Responses read as the side a request comes from.
 *
 * Namespaces are flattened out of tool names on the way in, and that mapping
 * decides what the client sees on the way out: a name the upstream invented has
 * to be stated again the way the caller wrote it.
 */
export const openaiResponsesSourceProtocol: SourceProtocol<
  'openaiResponses', OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx
> = {
  name: 'openaiResponses',
  read: openaiResponsesRead,
  roundTrip: {
    inspect: findOpenAIResponsesSidecarCarriers,
    verify: verifyOpenAIResponsesTurnDigest,
    collectCandidates: collectOpenAIResponsesReplayContents,
  },
  writeError: openaiResponsesErrorWriter,
  writeStream: (reading, records, writer) => {
    // A name the upstream invented has to be stated again the way this client
    // wrote it, so the mapping back to the pair is recovered from the request.
    const grouped = groupedCallNamesFromIR(reading.request, reading.turns.flatMap(turn => turn.toIRTurn()));
    // A response id names the upstream response, so one is minted per trip.
    const responseId = createRandomOpenAIResponsesResponseId();
    return openaiResponsesFromIR(records, { id: responseId, groupedCallNames: grouped, roundTrip: writer });
  },
};
