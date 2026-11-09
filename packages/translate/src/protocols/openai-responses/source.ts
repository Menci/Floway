import { openaiResponsesErrorWriter } from './as-source/error-body.ts';
import { openaiResponsesDropsReasoning, openaiResponsesOpen, type OpenAIResponsesExtra } from './as-source/input-to.ts';
import { restoreNamespaceEvents } from './as-source/namespace-tools.ts';
import { createRandomOpenAIResponsesResponseId } from './as-source/response-id.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from './as-source/round-trip.ts';
import { openaiResponsesFromIR } from './as-source/sse-to.ts';
import type { SourceProtocol } from '../composition.ts';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

/**
 * OpenAI Responses read as the side a request comes from.
 *
 * Namespaces are flattened out of tool names on the way in, and that mapping
 * decides what the client sees on the way out: a name the upstream invented has
 * to be stated again the way the caller wrote it.
 */
export const openaiResponsesSourceProtocol: SourceProtocol<
  'openaiResponses', OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx, OpenAIResponsesExtra
> = {
  name: 'openaiResponses',
  open: openaiResponsesOpen,
  dropsReasoning: openaiResponsesDropsReasoning,
  roundTrip: {
    inspect: findOpenAIResponsesSidecarCarriers,
    verify: verifyOpenAIResponsesTurnDigest,
    collectCandidates: collectOpenAIResponsesReplayContents,
  },
  writeError: openaiResponsesErrorWriter,
  writeStream: (layout, records, writer) => {
    // A response id names the upstream response, so one is minted per trip.
    const responseId = createRandomOpenAIResponsesResponseId();
    return restoreNamespaceEvents(
      openaiResponsesFromIR(records, {
        id: responseId,
        namespaceToolNames: layout.extra.namespaceToolNames,
        roundTrip: writer,
      }),
      layout.extra.namespaceToolNames,
    );
  },
};
