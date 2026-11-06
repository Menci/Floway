import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesRequestFromIR } from '../../openai-responses/as-target/input-from.ts';
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
  // The top-level `system` field is the request's prompt, which the target's
  // dedicated slot carries. Stating it as its own leading segment keeps it apart
  // from the conversation: a system message inside `messages` is one the caller
  // placed there, so it must not be lifted along with the prompt.
  const prompt = source.prompt === undefined
    ? undefined
    : openaiResponsesRequestFromIR({ ...source.request, conversation: { turns: [source.prompt] } }, true);
  if (prompt !== undefined) pieces.push({ kind: 'resolved', turn: prompt.input });
  let messageIndex = 0;
  for (const turn of source.conversation) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiResponses', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        messageIndex += turn.items.length;
        continue;
      }
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiResponses');
    }
    pieces.push(...source.turnToIR(turn, messageIndex));
    messageIndex += turn.items.length;
  }

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, `reasoning.summary`, or
  // `reasoning.context` when the Messages source did not express those knobs.
  // The prompt already occupies the target's slot, so the conversation must
  // not lift a leading system message into it as well.
  const base = openaiResponsesPayloadFromSegments(source.request, pieces, turn => turn, false);
  return { ...base, ...(prompt?.instructions == null ? {} : { instructions: prompt.instructions }) };
};
