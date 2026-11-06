import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesRequestFromIR } from '../../openai-responses/as-target/input-from.ts';
import { geminiGenerateContentText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentRequestToIR, geminiGenerateContentTurnToIR } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);
  const ir = geminiGenerateContentRequestToIR(payload, model);
  const instructions = geminiGenerateContentText(payload.systemInstruction);

  let contentIndex = 0;
  const pieces: (IRInputTurn | IRInputResolvedTurn<CanonicalOpenAIResponsesInputItem[]>)[] = [];
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiResponses', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        for (const item of roundTrip.turn) {
          if (item.type !== 'function_call' && item.type !== 'custom_tool_call') continue;
          unmatchedToolCallIds[item.name] ??= [];
          unmatchedToolCallIds[item.name].push(item.call_id);
        }
        contentIndex += turn.items.length;
        continue;
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiResponses');
    }
    pieces.push(geminiGenerateContentTurnToIR(turn, contentIndex, unmatchedToolCallIds));
    contentIndex += turn.items.length;
  }

  const input: CanonicalOpenAIResponsesInputItem[] = [];
  let base: CanonicalOpenAIResponsesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { input.push(...piece.turn); continue; }
    const translated = openaiResponsesRequestFromIR({ ...ir, conversation: { turns: piece.turns } }, false);
    base ??= translated;
    input.push(...translated.input);
  }
  base ??= openaiResponsesRequestFromIR({ ...ir, conversation: { turns: [] } }, false);

  // A GenerateContent system instruction is a Responses `instructions` string.
  return {
    ...base,
    input,
    ...(instructions === null ? {} : { instructions }),
  };
};
