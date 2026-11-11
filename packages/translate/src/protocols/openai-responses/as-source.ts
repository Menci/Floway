import { restateOpenAIResponsesError } from './as-source/error-body.ts';
import { createRandomOpenAIResponsesResponseId, writeOpenAIResponsesEvents } from './as-source/events.ts';
import { readOpenAIResponsesRequest } from './as-source/input-to.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarOccurrences, verifyOpenAIResponsesTurnDigest } from './as-source/round-trip.ts';
import type { SourceProtocol } from '../../composition/index.ts';
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
  read: readOpenAIResponsesRequest,
  sidecarRecognition: {
    inspect: findOpenAIResponsesSidecarOccurrences,
    verify: verifyOpenAIResponsesTurnDigest,
    collectCandidates: collectOpenAIResponsesReplayContents,
  },
  error: restateOpenAIResponsesError,
  writeEvents: (payload, records, roundTrip) => {
    // A response id names the upstream response, so one is minted per trip.
    const responseId = createRandomOpenAIResponsesResponseId();
    // The response objects echo the client's own declarations, which only the
    // payload states as the client wrote them: the IR holds a normalized form
    // and the upstream states none of this at all.
    const { tools, tool_choice: toolChoice } = payload;
    return writeOpenAIResponsesEvents(records, {
      id: responseId,
      roundTrip,
      ...(tools == null || tools.length === 0 ? {} : { echoedTools: tools }),
      ...(toolChoice == null ? {} : { echoedToolChoice: toolChoice }),
    });
  },
};
