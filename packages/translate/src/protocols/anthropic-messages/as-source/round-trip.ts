import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import type { ReplayContent } from '../../../round-trip/reference/assistant-turn.ts';
import type { EncodedRoundTripSidecar } from '../../../round-trip/resolve.ts';
import { collectTextGroups, collectTextPlacementIndex, type TextContribution, type TextPlacementIndex } from '../../../round-trip/text-groups.ts';
import { computeRoundTripTurnDigest, replayMaterialsByType, verifyRoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { RoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesRedactedThinkingBlock } from '@floway-dev/protocols/anthropic-messages';

type AnthropicMessagesReplayPart = NonNullable<Exclude<AnthropicMessagesAssistantTurn[number]['content'], string>>[number];
type AnthropicMessagesTextGroup = 'text' | 'thinking';

const anthropicMessagesTextGroup = (part: AnthropicMessagesReplayPart): TextContribution<AnthropicMessagesTextGroup> | undefined => {
  if (part.type === 'text') return { channel: part.type, field: 'text', text: part.text };
  if (part.type === 'thinking') return { channel: part.type, field: 'thinking', text: part.thinking };
  return undefined;
};

export type AnthropicMessagesAssistantTurn = (AnthropicMessagesAssistantMessage | { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] })[];

type TypedReplayMaterial = IRJSONObject & { type: string };

const messageTurnDigestMaterialV1 = (message: AnthropicMessagesAssistantTurn[number]): IRJSONValue => {
  const blocks: TypedReplayMaterial[] = [];
  if (typeof message.content === 'string') return replayMaterialsByType([{ type: 'text', text: message.content, citations: [] }]);
  const channels = collectTextGroups(message.content, anthropicMessagesTextGroup);
  const citations: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') citations.push(...(block.citations?.map(citation => citation.cited_text) ?? []));
    else if (block.type === 'tool_use') blocks.push({ type: block.type, id: block.id, name: block.name, input: requireJSONObject(block.input) });
    else if (block.type !== 'thinking') blocks.push({ type: block.type });
  }
  const text = channels.get('text');
  const thinking = channels.get('thinking');
  if (text !== undefined) blocks.push({ type: 'text', text: text.text, citations });
  if (thinking !== undefined) blocks.push({ type: 'thinking', thinking: thinking.text });
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

export const collectAnthropicMessagesReplayContents = (turn: AnthropicMessagesAssistantTurn): ReplayContent[] => {
  const candidates: ReplayContent[] = [];
  for (const message of turn) {
    if (typeof message.content === 'string') candidates.push(message.content);
    else {
      for (const channel of collectTextGroups(message.content, anthropicMessagesTextGroup).values()) candidates.push(channel.text);
      for (const block of message.content) {
        if (block.type === 'text') for (const citation of block.citations ?? []) candidates.push(citation.cited_text);
        else if (block.type === 'tool_use' && isPlainJSONObject(block.input)) candidates.push(block.input);
      }
    }
  }
  return candidates;
};

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

export const collectAnthropicMessagesTextViews = (turn: AnthropicMessagesAssistantTurn): TextPlacementIndex => {
  const views: TextPlacementIndex = new Map();
  for (const message of turn) {
    if (Array.isArray(message.content)) collectTextPlacementIndex(collectTextGroups(message.content, anthropicMessagesTextGroup), views);
  }
  return views;
};
