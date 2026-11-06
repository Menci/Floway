import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesPayloadFromSegments } from '../../openai-responses/as-target/segmented-request.ts';
import { partitionOpenAIChatCompletionsTurns } from '../as-source/conversation-turns.ts';
import { openaiChatCompletionsRequestToIR, openaiChatCompletionsInputContext, openaiChatCompletionsDropsReasoning, openaiChatCompletionsTurnToIR } from '../as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../as-source/round-trip.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const buildTargetRequest = async (
  payload: OpenAIChatCompletionsPayload,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const customToolCallIds = new Set<string>();
  const context = openaiChatCompletionsInputContext(payload);

  // A resolved assistant turn is already native Responses structure, so it
  // splits the conversation into output IR segments around itself.
  const pieces: (IRInputTurn | IRInputResolvedTurn<readonly CanonicalOpenAIResponsesInputItem[]>)[] = [];
  for (const turn of partitionOpenAIChatCompletionsTurns(payload.messages)) {
    const roundTrip = turn.role === 'assistant'
      ? await roundTripAssistantTurn(
          'openaiChatCompletions', 'openaiResponses', turn.items[0], codec,
          findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest, collectOpenAIChatCompletionsReplayContents,
        )
      : undefined;
    if (roundTrip !== undefined) { pieces.push({ kind: 'resolved', turn: roundTrip.turn }); continue; }
    if (openaiChatCompletionsDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiChatCompletions', 'openaiResponses');
    pieces.push(openaiChatCompletionsTurnToIR(turn, context));
  }

  const ir = openaiChatCompletionsRequestToIR(payload);
  return openaiResponsesPayloadFromSegments(ir, pieces, turn => {
    for (const item of turn) if (item.type === 'custom_tool_call') customToolCallIds.add(item.call_id);
    return turn;
  });
};
