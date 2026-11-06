import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import { irInputCustomToolNames } from '../../../ir/input/select-tools.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsPayloadFromSegments } from '../../openai-chat-completions/as-target/segmented-request.ts';
import { openaiResponsesDropsReasoning, openaiResponsesSource } from '../as-source/input-to.ts';
import type { NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

export interface TargetRequestResult {
  target: OpenAIChatCompletionsPayload;
  namespaceToolNames: NamespaceToolNames;
  /**
   * Names of OpenAI Responses `custom` tools the request translator wrapped as
   * single-string function tools. Returned alongside the translated payload so
   * the trip's events translator can project wrapped function calls back into
   * `custom_tool_call` outputs.
   */
  readonly customToolNames: ReadonlySet<string>;
}

export const buildTargetRequest = async (input: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec): Promise<TargetRequestResult> => {
  const source = openaiResponsesSource(input);
  const ir = source.request;

  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  // `instructions` is the request's own prompt field, so it opens the
  // conversation ahead of the messages the caller wrote.
  if (source.prompt !== undefined) pieces.push(source.prompt);
  for (const turn of source.conversation) {
    const roundTrip = turn.role === 'assistant' && await roundTripAssistantTurn('openaiResponses', 'openaiChatCompletions', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
    if (roundTrip) {
      pieces.push({ kind: 'resolved', turn: roundTrip.turn });
      continue;
    }
    if (openaiResponsesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'openaiChatCompletions');
    pieces.push(...source.turnToIR(turn));
  }

  const target = openaiChatCompletionsPayloadFromSegments(ir, pieces, turn => turn);

  // Chat cannot express a freeform declaration on every upstream, so the writer
  // states one as a single-string function; the names let its returned calls be
  // recognised as freeform again.
  return { target, customToolNames: irInputCustomToolNames(ir), namespaceToolNames: source.namespaceToolNames };
};
