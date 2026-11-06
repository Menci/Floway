import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesPayloadFromSegments } from '../../openai-responses/as-target/segmented-request.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentSource, type GeminiGenerateContentResolvedCall } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const source = geminiGenerateContentSource(payload, model);
  const pieces: (IRInputTurn | IRInputResolvedTurn<CanonicalOpenAIResponsesInputItem[]>)[] = [];
  for (const turn of source.conversation) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiResponses', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        source.observeResolvedTurn(turn, roundTripCalls(roundTrip.turn));
        continue;
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiResponses');
    }
    pieces.push(...source.turnToIR(turn));
  }

  // The system instruction is the conversation's leading prompt and joins the
  // pieces as its own segment, so the writer states it in its own slot.
  if (source.prompt !== undefined) pieces.unshift(source.prompt);

  return openaiResponsesPayloadFromSegments(source.request, pieces, turn => turn);
};

const roundTripCalls = (items: readonly CanonicalOpenAIResponsesInputItem[]): GeminiGenerateContentResolvedCall[] =>
  items.flatMap(item => item.type === 'function_call' || item.type === 'custom_tool_call'
    ? [{ callId: item.call_id, name: item.name }]
    : []);
