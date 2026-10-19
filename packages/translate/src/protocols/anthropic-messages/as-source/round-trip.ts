import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import type { EncodedRoundTripSidecar } from '../../../round-trip/resolve.ts';
import { computeRoundTripTurnDigest, replayMaterialsByType, verifyRoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { RoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesRedactedThinkingBlock } from '@floway-dev/protocols/anthropic-messages';

export type AnthropicMessagesAssistantTurn = (AnthropicMessagesAssistantMessage | { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] })[];

type TypedReplayMaterial = IRJSONObject & { type: string };

const messageTurnDigestMaterialV1 = (message: AnthropicMessagesAssistantTurn[number]): IRJSONValue => {
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

const messagesTurnDigestMaterialV1 = (turn: AnthropicMessagesAssistantTurn): IRJSONValue => turn.map(messageTurnDigestMaterialV1);

export const findAnthropicMessagesSidecarCarriers = (turn: AnthropicMessagesAssistantTurn): EncodedRoundTripSidecar<AnthropicMessagesAssistantTurn>[] =>
  turn.flatMap((message, messageIndex) => {
    const content = message.content;
    return typeof content === 'string' ? [] : content.flatMap((block, blockIndex) => block.type !== 'redacted_thinking' ? [] : [{
      data: block.data,
      withoutSidecar: () => turn.map((item, index) => index === messageIndex
        ? { ...message, content: content.filter((_, index) => index !== blockIndex) }
        : item),
    }]);
  });

export const computeAnthropicMessagesTurnDigest = (turn: AnthropicMessagesAssistantTurn): Promise<RoundTripTurnDigest> =>
  computeRoundTripTurnDigest(messagesTurnDigestMaterialV1(turn));

export const verifyAnthropicMessagesTurnDigest = (
  turn: AnthropicMessagesAssistantTurn,
  sourceTurnDigest: RoundTripTurnDigest,
  version: number,
): Promise<boolean> => {
  switch (version) {
  case 1: return verifyRoundTripTurnDigest(messagesTurnDigestMaterialV1(turn), sourceTurnDigest);
  default: return Promise.resolve(false);
  }
};

export const createAnthropicMessagesSidecarCarrier = (data: string): AnthropicMessagesRedactedThinkingBlock => ({ type: 'redacted_thinking', data });
