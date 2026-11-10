import type { SourceProtocol } from '../composition.ts';
import { restateOpenAIResponsesError } from './as-source/error-body.ts';
import { openaiResponsesRead } from './as-source/input-to.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from './as-source/round-trip.ts';
import { createRandomOpenAIResponsesResponseId, openaiResponsesFromIR } from './as-source/sse-to.ts';
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
  sidecarRecognition: {
    inspect: findOpenAIResponsesSidecarCarriers,
    verify: verifyOpenAIResponsesTurnDigest,
    collectCandidates: collectOpenAIResponsesReplayContents,
  },
  restateUpstreamError: restateOpenAIResponsesError,
  writeStream: (_request, payload, records, roundTrip) => {
    // A response id names the upstream response, so one is minted per trip.
    const responseId = createRandomOpenAIResponsesResponseId();
    // The response objects echo the client's own declarations, which only the
    // payload states as the client wrote them: the IR holds a normalized form
    // and the upstream states none of this at all.
    const { tools, tool_choice: toolChoice } = payload;
    return openaiResponsesFromIR(records, {
      id: responseId,
      roundTrip,
      ...(tools == null || tools.length === 0 ? {} : { echoedTools: tools }),
      ...(toolChoice == null ? {} : { echoedToolChoice: toolChoice }),
    });
  },
};
