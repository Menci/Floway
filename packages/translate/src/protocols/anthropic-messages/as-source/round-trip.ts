
import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection } from '../../../round-trip/replay.ts';
import { canonicalTextParts, isPureTextPart, type PureTextPart } from '../../../round-trip/text-parts.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesRedactedThinkingBlock } from '@floway-dev/protocols/anthropic-messages';

type AnthropicMessagesReplayPart = NonNullable<Exclude<AnthropicMessagesAssistantTurn[number]['content'], string>>[number];

const isAnthropicMessagesPureTextPart = <Part extends AnthropicMessagesReplayPart>(part: Part): part is Part & PureTextPart =>
  isPureTextPart(part, ['text'], ['citations']);

export const ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION = 1;

export type AnthropicMessagesAssistantTurn = (AnthropicMessagesAssistantMessage | { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] })[];

type TypedReplayMaterial = IRJSONObject & { type: string };

const messagesReplayCheckMaterialV1 = (turn: AnthropicMessagesAssistantTurn): IRJSONValue => {
  const blocks: TypedReplayMaterial[] = [];
  for (const message of turn) {
    if (typeof message.content === 'string') {
      blocks.push({ type: 'text', text: message.content, citations: [] });
      continue;
    }
    for (const block of canonicalTextParts<AnthropicMessagesReplayPart>(message.content, isAnthropicMessagesPureTextPart)) {
      if (block.type === 'text') blocks.push({
        type: block.type,
        text: block.text,
        citations: block.citations?.map(citation => citation.cited_text) ?? [],
      });
      else if (block.type === 'thinking') blocks.push({ type: block.type, thinking: block.thinking });
      else if (block.type === 'tool_use') blocks.push({ type: block.type, id: block.id, name: block.name, input: requireJSONObject(block.input) });
      else blocks.push({ type: block.type });
    }
  }
  return replayMaterialsByType(blocks);
};

export const inspectAnthropicMessagesAssistantTurn = (turn: AnthropicMessagesAssistantTurn): RoundTripAssistantTurnInspection<AnthropicMessagesAssistantTurn> => {
  const message = turn.at(-1);
  if (message === undefined || typeof message.content === 'string') return { turn };
  const block = message.content.at(-1);
  if (block?.type !== 'redacted_thinking') return { turn };
  return {
    sidecar: block.data,
    turn: [...turn.slice(0, -1), { ...message, content: message.content.slice(0, -1) }],
  };
};

export const computeAnthropicMessagesReplayCheck = (turn: AnthropicMessagesAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION, messagesReplayCheckMaterialV1(turn));

export const verifyAnthropicMessagesReplayCheck = (
  turn: AnthropicMessagesAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(messagesReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};

export const createAnthropicMessagesSidecarCarrier = (data: string): AnthropicMessagesRedactedThinkingBlock => ({ type: 'redacted_thinking', data });
