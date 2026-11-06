import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { anthropicMessagesPayloadFromSegments } from '../../anthropic-messages/as-target/segmented-request.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentSource, type GeminiGenerateContentResolvedCall } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
  options: { fallbackMaxOutputTokens: number | undefined },
): Promise<AnthropicMessagesPayload> => {
  const source = geminiGenerateContentSource(payload, model);
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesPayload['messages'][number]>)[] = [];
  for (const turn of source.conversation) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'anthropicMessages', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        source.observeResolvedTurn(turn, roundTripCalls(roundTrip.turn));
        continue;
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'anthropicMessages');
    }
    pieces.push(...source.turnToIR(turn));
  }

  // The system instruction is the conversation's leading prompt and joins the
  // pieces as its own segment, so the writer states it in its own slot.
  if (source.prompt !== undefined) pieces.unshift(source.prompt);

  return await anthropicMessagesPayloadFromSegments(
    source.request,
    pieces,
    turn => turn,
    { fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
  );
};

const roundTripCalls = (message: AnthropicMessagesPayload['messages'][number]): GeminiGenerateContentResolvedCall[] => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.flatMap(block => block.type === 'tool_use' || block.type === 'server_tool_use'
    ? [{ callId: block.id, name: block.name }]
    : []);
};
