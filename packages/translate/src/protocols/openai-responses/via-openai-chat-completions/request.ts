import { irInputCustomToolNames } from '../../../ir/input/select-tools.ts';
import { readIRInput } from '../../../ir/input/source.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsPayloadFromSegments } from '../../openai-chat-completions/as-target/segmented-request.ts';
import { openaiResponsesDropsReasoning, openaiResponsesSource } from '../as-source/input-to.ts';
import type { NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
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

  const pieces = await readIRInput(source, async turn => {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('openaiResponses', 'openaiChatCompletions', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
      if (roundTrip !== undefined) return { resolved: roundTrip.turn, calls: [] };
    }
    if (openaiResponsesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'openaiChatCompletions');
    return undefined;
  });

  const target = openaiChatCompletionsPayloadFromSegments(source.request, pieces, turn => turn);

  // Chat cannot express a freeform declaration on every upstream, so the writer
  // states one as a single-string function; the names let its returned calls be
  // recognised as freeform again.
  return { target, customToolNames: irInputCustomToolNames(source.request), namespaceToolNames: source.namespaceToolNames };
};
