import { readIRInput } from '../../../ir/input/source.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsPayloadFromSegments } from '../../openai-chat-completions/as-target/segmented-request.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentSource } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const source = geminiGenerateContentSource(payload, model);
  const pieces = await readIRInput(source, async turn => {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiChatCompletions', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        const message = roundTrip.turn;
        return {
          resolved: message,
          calls: (message.role === 'assistant' && 'tool_calls' in message ? message.tool_calls ?? [] : [])
            .map(call => ({ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name })),
        };
      }
    }
    if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiChatCompletions');
    return undefined;
  });

  return openaiChatCompletionsPayloadFromSegments(source.request, pieces, turn => turn);
};
