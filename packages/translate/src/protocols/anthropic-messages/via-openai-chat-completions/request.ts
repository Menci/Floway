import { readIRInput } from '../../../ir/input/source.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsPayloadFromSegments } from '../../openai-chat-completions/as-target/segmented-request.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSource } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const source = anthropicMessagesSource(payload);
  const pieces = await readIRInput(source, async turn => {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiChatCompletions', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) return { resolved: roundTrip.turn, calls: [] };
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiChatCompletions');
    }
    return undefined;
  });

  return openaiChatCompletionsPayloadFromSegments(source.request, pieces, turn => turn);
};
