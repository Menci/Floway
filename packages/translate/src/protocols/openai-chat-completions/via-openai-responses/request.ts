import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesRequestFromIR } from '../../openai-responses/as-target/input-from.ts';
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

  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const instructions: string[] = [];

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
  let base: CanonicalOpenAIResponsesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') {
      input.push(...piece.turn);
      for (const item of piece.turn) if (item.type === 'custom_tool_call') customToolCallIds.add(item.call_id);
      continue;
    }
    const translated = openaiResponsesRequestFromIR({ ...ir, conversation: { turns: piece.turns } }, piece.leading);
    base ??= translated;
    if (translated.instructions != null) instructions.push(translated.instructions);
    input.push(...translated.input);
  }

  // The conversation came from the segments; a request without one still states
  // its settings and tools.
  base ??= openaiResponsesRequestFromIR({ ...ir, conversation: { turns: [] } });

  return {
    ...base,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
  };
};
