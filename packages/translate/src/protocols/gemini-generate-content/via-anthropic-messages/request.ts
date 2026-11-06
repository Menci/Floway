import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { anthropicMessagesPayloadFromSegments } from '../../anthropic-messages/as-target/segmented-request.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentContentsToIRTurns, geminiGenerateContentDropsReasoning, geminiGenerateContentRequestToIR, geminiGenerateContentSystemToIR } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
  options: { fallbackMaxOutputTokens: number | undefined },
): Promise<AnthropicMessagesPayload> => {
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);

  let contentIndex = 0;
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesPayload['messages'][number]>)[] = [];
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'anthropicMessages', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        if (Array.isArray(roundTrip.turn.content)) for (const block of roundTrip.turn.content) {
          if (block.type !== 'tool_use' && block.type !== 'server_tool_use') continue;
          unmatchedToolCallIds[block.name] ??= [];
          unmatchedToolCallIds[block.name].push(block.id);
        }
        contentIndex += turn.items.length;
        continue;
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'anthropicMessages');
    }
    pieces.push(...geminiGenerateContentContentsToIRTurns(turn, contentIndex, unmatchedToolCallIds));
    contentIndex += turn.items.length;
  }

  const ir = geminiGenerateContentRequestToIR(payload, model);
  // The pieces above were built from `contents` alone; the system instruction is
  // the conversation's leading prompt and joins them as its own segment.
  const system = geminiGenerateContentSystemToIR(payload.systemInstruction);
  if (system !== undefined) pieces.unshift(system);
  return await anthropicMessagesPayloadFromSegments(
    ir,
    pieces,
    turn => turn,
    { fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
  );
};
