import type { IRRecord } from '../../ir/output/stream.ts';
import type { RoundTripWriter } from '../../round-trip/stream.ts';
import type { SourceProtocol, SourceReading } from '../composition.ts';
import type { OpenAIResponsesConversationTurn } from './as-source/conversation-turns.ts';
import { openaiResponsesErrorWriter } from './as-source/error-body.ts';
import { openaiResponsesDropsReasoning, openaiResponsesSource, type OpenAIResponsesSource } from './as-source/input-to.ts';
import { restoreNamespaceEvents, type NamespaceToolNames } from './as-source/namespace-tools.ts';
import { createRandomOpenAIResponsesResponseId } from './as-source/response-id.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, type OpenAIResponsesAssistantTurn } from './as-source/round-trip.ts';
import { openaiResponsesFromIR } from './as-source/sse-to.ts';
import type { OpenAIResponsesRequestPayloadEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

/**
 * OpenAI Responses read as the side a request comes from.
 *
 * Two rewrites this protocol performs on the way in have to be undone on the
 * way out: namespaces are flattened out of tool names, and freeform tools are
 * stated as functions. Both are recorded while reading the request and replayed
 * when stating the stream, which is why this reading keeps them.
 */
export const openaiResponsesSourceProtocol: SourceProtocol<
  'openaiResponses', OpenAIResponsesRequestPayloadEx, OpenAIResponsesConversationTurn, OpenAIResponsesAssistantTurn, OpenAIResponsesStreamEventEx, NamespaceToolNames
> = {
  name: 'openaiResponses',
  read: (payload): SourceReading<'openaiResponses', OpenAIResponsesConversationTurn, OpenAIResponsesAssistantTurn, OpenAIResponsesStreamEventEx, NamespaceToolNames> => {
    const source: OpenAIResponsesSource = openaiResponsesSource(payload);
    const responseId = createRandomOpenAIResponsesResponseId();
    return {
      request: source.request,
      input: source,
      extra: source.namespaceToolNames,
      assistantTurn: turn => turn.role === 'assistant' ? turn.items : undefined,
      dropsReasoning: openaiResponsesDropsReasoning,
      roundTrip: {
        inspect: findOpenAIResponsesSidecarCarriers,
        verify: verifyOpenAIResponsesTurnDigest,
        collectCandidates: collectOpenAIResponsesReplayContents,
      },
      output: (records: AsyncIterable<IRRecord>, writer: RoundTripWriter<'openaiResponses'>) =>
        restoreNamespaceEvents(
          openaiResponsesFromIR(records, {
            id: responseId,
            namespaceToolNames: source.namespaceToolNames,
            roundTrip: writer,
          }),
          source.namespaceToolNames,
        ),
    };
  },
  writeError: openaiResponsesErrorWriter,
};
