import type { SourceProtocol } from '../composition.ts';
import { openaiResponsesErrorWriter } from './as-source/error-body.ts';
import { openaiResponsesRead } from './as-source/input-to.ts';
import { createRandomOpenAIResponsesResponseId } from './as-source/response-id.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from './as-source/round-trip.ts';
import { openaiResponsesFromIR } from './as-source/sse-to.ts';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

/**
 * OpenAI Responses read as the side a request comes from.
 *
 * This wire groups callables, so the reader keeps a call's group as
 * `namespace`. The client-side writer states the pair back from the output IR.
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
    // A response id names the upstream response, so one is minted per trip.
    const responseId = createRandomOpenAIResponsesResponseId();
    return openaiResponsesFromIR(records, { id: responseId, roundTrip: writer });
  },
};
