import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { canonicalTextParts, collectCanonicalTextViews, isPureTextPart, type CanonicalTextView, type PureTextPart } from '../../../round-trip/text-parts.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
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

export const inspectAnthropicMessagesAssistantTurn = (turn: AnthropicMessagesAssistantTurn): RoundTripSidecarCandidate<AnthropicMessagesAssistantTurn>[] =>
  turn.flatMap((message, messageIndex) => {
    const content = message.content;
    return typeof content === 'string' ? [] : content.flatMap((block, blockIndex) => block.type !== 'redacted_thinking' ? [] : [{
      data: block.data,
      withoutSidecar: () => turn.map((item, index) => index === messageIndex
        ? { ...message, content: content.filter((_, index) => index !== blockIndex) }
        : item),
    }]);
  });

export const computeAnthropicMessagesReplayCheck = (turn: AnthropicMessagesAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION, messagesReplayCheckMaterialV1(turn));

export const collectAnthropicMessagesReplayCandidates = (turn: AnthropicMessagesAssistantTurn): ReplayCandidate[] => {
  const candidates: ReplayCandidate[] = [];
  for (const message of turn) {
    if (typeof message.content === 'string') candidates.push(message.content);
    else for (const block of canonicalTextParts<AnthropicMessagesReplayPart>(message.content, isAnthropicMessagesPureTextPart)) {
      if (block.type === 'text') {
        candidates.push(block.text);
        for (const citation of block.citations ?? []) candidates.push(citation.cited_text);
      } else if (block.type === 'thinking') candidates.push(block.thinking);
      else if (block.type === 'tool_use' && isPlainJSONObject(block.input)) candidates.push(block.input);
    }
  }
  return candidates;
};

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

export const collectAnthropicMessagesTextViews = (turn: AnthropicMessagesAssistantTurn): Map<object, CanonicalTextView> => {
  const views = new Map<object, CanonicalTextView>();
  for (const message of turn) if (Array.isArray(message.content)) collectCanonicalTextViews<AnthropicMessagesReplayPart>(message.content, isAnthropicMessagesPureTextPart, views);
  return views;
};
