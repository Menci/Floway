import { readIRInput } from '../../../ir/input/source.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesPayloadFromSegments } from '../../openai-responses/as-target/segmented-request.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSource } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const source = anthropicMessagesSource(payload);
  const pieces = await readIRInput(source, async turn => {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiResponses', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) return { resolved: roundTrip.turn, calls: [] };
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiResponses');
    }
    return undefined;
  });

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, `reasoning.summary`, or
  // `reasoning.context` when the Messages source did not express those knobs.
  return openaiResponsesPayloadFromSegments(source.request, pieces, turn => turn);
};
