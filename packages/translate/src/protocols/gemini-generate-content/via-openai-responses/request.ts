import { readIRInput } from '../../../ir/input/source.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesPayloadFromSegments } from '../../openai-responses/as-target/segmented-request.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentSource } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const source = geminiGenerateContentSource(payload, model);
  const pieces = await readIRInput(source, async turn => {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiResponses', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        return {
          resolved: roundTrip.turn,
          calls: roundTrip.turn.flatMap(item => item.type === 'function_call' || item.type === 'custom_tool_call' ? [{ callId: item.call_id, name: item.name }] : []),
        };
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiResponses');
    }
    return undefined;
  });

  return openaiResponsesPayloadFromSegments(source.request, pieces, turn => [...turn]);
};
