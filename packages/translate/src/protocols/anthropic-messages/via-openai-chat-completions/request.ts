import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsPayloadFromSegments } from '../../openai-chat-completions/as-target/segmented-request.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSource } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const source = anthropicMessagesSource(payload);
  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  // The top-level `system` field is the request's prompt, so it opens the
  // conversation; the writer places it like any other turn.
  if (source.prompt !== undefined) pieces.push(source.prompt);
  for (const turn of source.conversation) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiChatCompletions', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        source.observeResolvedTurn(turn);
        continue;
      }
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiChatCompletions');
    }
    pieces.push(...source.turnToIR(turn));
  }

  return openaiChatCompletionsPayloadFromSegments(source.request, pieces, turn => turn);
};
