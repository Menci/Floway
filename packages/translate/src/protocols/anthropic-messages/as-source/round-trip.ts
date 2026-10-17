import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { collectTextChannels, collectTextChannelViews, type TextChannelProjection, type TextChannelViews } from '../../../round-trip/text-channels.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage, AnthropicMessagesRedactedThinkingBlock } from '@floway-dev/protocols/anthropic-messages';

type AnthropicMessagesReplayPart = NonNullable<Exclude<AnthropicMessagesAssistantTurn[number]['content'], string>>[number];
type AnthropicMessagesTextChannel = 'text' | 'thinking';

const anthropicMessagesTextChannel = (part: AnthropicMessagesReplayPart): TextChannelProjection<AnthropicMessagesTextChannel> | undefined => {
  if (part.type === 'text') return { channel: part.type, field: 'text', text: part.text };
  if (part.type === 'thinking') return { channel: part.type, field: 'thinking', text: part.thinking };
  return undefined;
};

export const ANTHROPIC_MESSAGES_REPLAY_CHECK_VERSION = 1;

export type AnthropicMessagesAssistantTurn = (AnthropicMessagesAssistantMessage | { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] })[];

type TypedReplayMaterial = IRJSONObject & { type: string };

const messageReplayCheckMaterialV1 = (message: AnthropicMessagesAssistantTurn[number]): IRJSONValue => {
  const blocks: TypedReplayMaterial[] = [];
  if (typeof message.content === 'string') return replayMaterialsByType([{ type: 'text', text: message.content, citations: [] }]);
  const channels = collectTextChannels(message.content, anthropicMessagesTextChannel);
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

export const collectAnthropicMessagesReplayCandidates = (turn: AnthropicMessagesAssistantTurn): ReplayCandidate[] => {
  const candidates: ReplayCandidate[] = [];
  for (const message of turn) {
    if (typeof message.content === 'string') candidates.push(message.content);
    else {
      for (const channel of collectTextChannels(message.content, anthropicMessagesTextChannel).values()) candidates.push(channel.text);
      for (const block of message.content) {
        if (block.type === 'text') for (const citation of block.citations ?? []) candidates.push(citation.cited_text);
        else if (block.type === 'tool_use' && isPlainJSONObject(block.input)) candidates.push(block.input);
      }
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

export const collectAnthropicMessagesTextViews = (turn: AnthropicMessagesAssistantTurn): TextChannelViews => {
  const views: TextChannelViews = new Map();
  for (const message of turn) {
    if (Array.isArray(message.content)) collectTextChannelViews(collectTextChannels(message.content, anthropicMessagesTextChannel), views);
  }
  return views;
};
