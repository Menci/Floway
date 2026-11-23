import type { RouteCandidate } from '../../../pipeline/services.ts';
import type { AffinityCodec, DecodedAffinityBlob } from '../../shared/affinity/carrier.ts';
import { type AffinityAnalysis, incompatibleReasoningParts, projectOptionalAffinityBlob } from '../../shared/affinity/selection.ts';
import type { AnthropicMessagesAssistantInputContentBlock, AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

interface AnthropicMessagesBlobLocation {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

export interface AnthropicMessagesAffinityAnalysis extends AffinityAnalysis {
  readonly locations: readonly AnthropicMessagesBlobLocation[];
}

export const analyzeAnthropicMessagesAffinity = async (
  payload: AnthropicMessagesPayload,
  codec: Pick<AffinityCodec, 'unwrap'>,
): Promise<AnthropicMessagesAffinityAnalysis> => {
  const locations: AnthropicMessagesBlobLocation[] = [];
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type === 'thinking' && typeof block.signature === 'string' && block.signature !== '') {
        locations.push({ messageIndex, blockIndex, decoded: await codec.unwrap(block.signature, 'anthropic-messages.thinking.signature') });
      } else if (block.type === 'redacted_thinking') {
        locations.push({ messageIndex, blockIndex, decoded: await codec.unwrap(block.data, 'anthropic-messages.redacted_thinking.data') });
      }
    }
  }

  return { requiredTargets: [], locations };
};

export const evaluateAnthropicMessagesAffinity = (
  analysis: AnthropicMessagesAffinityAnalysis,
  candidate: RouteCandidate,
  payload: AnthropicMessagesPayload,
) => {
  const locationsByMessage = Map.groupBy(analysis.locations, location => location.messageIndex);
  let degrades = false;
  let preferred = true;
  const messages = payload.messages.flatMap<AnthropicMessagesMessage>((message, messageIndex) => {
    const locations = locationsByMessage.get(messageIndex);
    if (locations === undefined) return [message];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) throw new Error('Anthropic Messages affinity expected assistant content blocks');
    const projections = new Map(locations.map(({ blockIndex, decoded }) => [blockIndex, projectOptionalAffinityBlob(decoded, candidate)]));
    // Thinking can only be replayed with its original upstream signature.
    // https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#preserving-thinking-blocks
    const dropped = incompatibleReasoningParts(message.content, projections, block => block.type === 'thinking');
    degrades ||= dropped.size > 0 || [...projections.values()].some(projection => projection.kind === 'remove' && projection.degrades);
    preferred &&= [...projections.values()].every(projection => projection.preferred);
    const content = message.content.flatMap<AnthropicMessagesAssistantInputContentBlock>((block, blockIndex) => {
      if (dropped.has(blockIndex)) return [];
      const projection = projections.get(blockIndex);
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
  return { kind: 'accepted' as const, degrades, preferred, payload: { ...payload, messages } };
};
