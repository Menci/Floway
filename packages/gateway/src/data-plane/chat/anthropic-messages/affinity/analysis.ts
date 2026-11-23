import type { RouteCandidate } from '../../../pipeline/services.ts';
import type { AffinityCodec, DecodedAffinityBlob } from '../../shared/affinity/carrier.ts';
import { type AffinityAnalysis, incompatibleReasoningParts, projectOptionalAffinityBlob } from '../../shared/affinity/selection.ts';
import type { AnthropicMessagesAssistantInputContentBlock, AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

interface AnthropicMessagesBlobLocation {
  readonly blockIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

interface AnthropicMessagesAffinityLocation {
  readonly messageIndex: number;
  readonly blocks: readonly AnthropicMessagesBlobLocation[];
}

export interface AnthropicMessagesAffinityAnalysis extends AffinityAnalysis {
  readonly locations: readonly AnthropicMessagesAffinityLocation[];
}

export const analyzeAnthropicMessagesAffinity = async (
  payload: AnthropicMessagesPayload,
  codec: Pick<AffinityCodec, 'unwrap'>,
): Promise<AnthropicMessagesAffinityAnalysis> => {
  const locations: AnthropicMessagesAffinityLocation[] = [];
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const blocks: AnthropicMessagesBlobLocation[] = [];
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature !== '') {
        blocks.push({ blockIndex, decoded: await codec.unwrap(block.signature, 'anthropic-messages.thinking.signature') });
      } else if (block.type === 'redacted_thinking') {
        blocks.push({ blockIndex, decoded: await codec.unwrap(block.data, 'anthropic-messages.redacted_thinking.data') });
      }
    }
    if (blocks.length > 0) locations.push({ messageIndex, blocks });
  }

  return { requiredTargets: [], locations };
};

const planAffinity = (
  analysis: AnthropicMessagesAffinityAnalysis,
  candidate: RouteCandidate,
  payload: AnthropicMessagesPayload,
) => {
  let degrades = false;
  let preferred = true;
  const projections = new Map(analysis.locations.map(({ messageIndex, blocks }) => {
    const message = payload.messages[messageIndex];
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) throw new Error('Anthropic Messages affinity expected assistant content blocks');
    const blocksByIndex = new Map(blocks.map(({ blockIndex, decoded }) => [blockIndex, projectOptionalAffinityBlob(decoded, candidate)]));
    // Thinking can only be replayed with its original upstream signature.
    // https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#preserving-thinking-blocks
    const dropped = incompatibleReasoningParts(message.content, blocksByIndex, block => block.type === 'thinking');
    const projected = [...blocksByIndex.values()];
    degrades ||= dropped.size > 0 || projected.some(projection => projection.kind === 'remove' && projection.degrades);
    preferred &&= projected.every(projection => projection.preferred);
    return [messageIndex, { blocksByIndex, dropped }] as const;
  }));
  return { kind: 'accepted' as const, degrades, preferred, projections };
};

export const scoreAnthropicMessagesAffinity = (
  analysis: AnthropicMessagesAffinityAnalysis,
  candidate: RouteCandidate,
  payload: AnthropicMessagesPayload,
) => {
  const { projections: _projections, ...score } = planAffinity(analysis, candidate, payload);
  return score;
};

export const evaluateAnthropicMessagesAffinity = (
  analysis: AnthropicMessagesAffinityAnalysis,
  candidate: RouteCandidate,
  payload: AnthropicMessagesPayload,
) => {
  const { projections, ...score } = planAffinity(analysis, candidate, payload);
  if (projections.size === 0) return { ...score, payload };
  const messages = payload.messages.flatMap<AnthropicMessagesMessage>((message, messageIndex) => {
    const projected = projections.get(messageIndex);
    if (projected === undefined) return [message];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) throw new Error('Anthropic Messages affinity expected assistant content blocks');
    const { blocksByIndex, dropped } = projected;
    const content = message.content.flatMap<AnthropicMessagesAssistantInputContentBlock>((block, blockIndex) => {
      if (dropped.has(blockIndex)) return [];
      const projection = blocksByIndex.get(blockIndex);
      if (projection === undefined) return [block];
      if (block.type === 'redacted_thinking') return projection.kind === 'preserve' ? [{ ...block, data: projection.value }] : [];
      if (block.type !== 'thinking') throw new Error('Anthropic Messages affinity location no longer points at thinking');
      if (projection.kind === 'preserve') return [{ ...block, signature: projection.value }];
      // The wire block may omit a signature the SDK type requires.
      const { signature: _signature, ...unsigned } = block;
      return [unsigned as typeof block];
    });
    return content.length === 0 ? [] : [{ ...message, content }];
  });
  return { ...score, payload: { ...payload, messages } };
};
