import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsPayloadFromSegments } from '../../openai-chat-completions/as-target/segmented-request.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentSource, type GeminiGenerateContentResolvedCall } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const source = geminiGenerateContentSource(payload, model);
  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  for (const turn of source.conversation) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiChatCompletions', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        source.observeResolvedTurn(turn, roundTripCalls(roundTrip.turn));
        continue;
      }
    }
    if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiChatCompletions');
    pieces.push(...source.turnToIR(turn));
  }

  // The system instruction is the conversation's leading prompt and joins the
  // pieces as its own segment, so the writer places it like any other turn.
  if (source.prompt !== undefined) pieces.unshift(source.prompt);

  return openaiChatCompletionsPayloadFromSegments(source.request, pieces, turn => turn);
};

const roundTripCalls = (message: OpenAIChatCompletionsMessage): GeminiGenerateContentResolvedCall[] => {
  if (message.role !== 'assistant') return [];
  const calls = 'tool_calls' in message ? message.tool_calls : undefined;
  return (calls ?? []).flatMap(call => [{ callId: call.id, name: call.type === 'function' ? call.function.name : call.custom.name }]);
};
