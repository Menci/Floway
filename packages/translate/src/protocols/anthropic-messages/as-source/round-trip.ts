
import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesRedactedThinkingBlock } from '@floway-dev/protocols/anthropic-messages';

export const ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION = 1;

export type AnthropicMessagesAssistantTurn = (AnthropicMessagesAssistantMessage | { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] })[];

type TypedReplayMaterial = IRJSONObject & { type: string };

const messageReplayCheckMaterialV1 = (message: AnthropicMessagesAssistantTurn[number]): IRJSONValue => {
  const blocks: TypedReplayMaterial[] = [];
  if (typeof message.content === 'string') return replayMaterialsByType([{ type: 'text', text: message.content, citations: [] }]);
  let text = '';
  let hasText = false;
  const citations: string[] = [];
  let thinking = '';
  let hasThinking = false;
  for (const block of message.content) {
    if (block.type === 'text') {
      hasText = true;
      text += block.text;
      citations.push(...(block.citations?.map(citation => citation.cited_text) ?? []));
    } else if (block.type === 'thinking') {
      hasThinking = true;
      thinking += block.thinking;
    } else if (block.type === 'tool_use') {
      blocks.push({ type: block.type, id: block.id, name: block.name, input: requireJSONObject(block.input) });
    } else blocks.push({ type: block.type });
  }
  if (hasText) blocks.push({ type: 'text', text, citations });
  if (hasThinking) blocks.push({ type: 'thinking', thinking });
  return replayMaterialsByType(blocks);
};

const messagesReplayCheckMaterialV1 = (turn: AnthropicMessagesAssistantTurn): IRJSONValue => turn.map(messageReplayCheckMaterialV1);

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
