import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesRequestFromIR } from '../../openai-responses/as-target/input-from.ts';
import { partitionAnthropicMessagesTurns } from '../as-source/conversation-turns.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSettingsToIR, anthropicMessagesSystemToIR, anthropicMessagesToolsToIR, anthropicMessagesTurnToIR } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const ir: IRInputRequest = {
    conversation: { turns: [] },
    settings: anthropicMessagesSettingsToIR(payload),
    ...anthropicMessagesToolsToIR(payload),
  };

  const pieces: (IRInputTurn | IRInputResolvedTurn<CanonicalOpenAIResponsesInputItem[]>)[] = [];
  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiResponses', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        messageIndex += turn.items.length;
        continue;
      }
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiResponses');
    }
    pieces.push(...anthropicMessagesTurnToIR(turn, messageIndex, ' user content blocks are not supported on this model'));
    messageIndex += turn.items.length;
  }

  const input: CanonicalOpenAIResponsesInputItem[] = [];
  let base: CanonicalOpenAIResponsesPayload | undefined;
  // The top-level `system` field is the request's prompt, which a target with a
  // dedicated slot states there. A system message inside `messages` is one the
  // caller placed in the conversation, so it keeps its position.
  const system = anthropicMessagesSystemToIR(payload.system);
  if (system !== undefined) {
    const hoisted = openaiResponsesRequestFromIR({ ...ir, conversation: { turns: [system] } }, true);
    base = hoisted;
    input.push(...hoisted.input);
  }
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { input.push(...piece.turn); continue; }
    const translated = openaiResponsesRequestFromIR({ ...ir, conversation: { turns: piece.turns } }, false);
    base ??= translated;
    input.push(...translated.input);
  }
  base ??= openaiResponsesRequestFromIR({ ...ir, conversation: { turns: [] } }, false);

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, `reasoning.summary`, or
  // `reasoning.context` when the Messages source did not express those knobs.
  return { ...base, input };
};
