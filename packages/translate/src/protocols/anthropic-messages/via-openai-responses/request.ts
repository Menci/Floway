import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesPayloadFromSegments } from '../../openai-responses/as-target/segmented-request.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSource } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const source = anthropicMessagesSource(payload);
  const pieces: (IRInputTurn | IRInputResolvedTurn<CanonicalOpenAIResponsesInputItem[]>)[] = [];
  // `instructions` is the request's prompt and a system message inside
  // `messages` is one the caller placed there. Both are prompt items in the IR,
  // and the writer hoists only the leading run, so stating the request's prompt
  // first keeps the two apart.
  if (source.prompt !== undefined) pieces.push(source.prompt);
  for (const turn of source.conversation) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiResponses', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) {
        // A held client turn sits before this resolved turn in the source, so it
        // is released first.
        pieces.push(...source.observeResolvedTurn(turn));
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        continue;
      }
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiResponses');
    }
    pieces.push(...source.turnToIR(turn));
  }
  pieces.push(...source.finish());

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, `reasoning.summary`, or
  // `reasoning.context` when the Messages source did not express those knobs.
  return openaiResponsesPayloadFromSegments(source.request, pieces, turn => turn);
};
