import { type AffinityCandidate, type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, incompatibleReasoningParts, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

interface AnthropicMessagesBlobLocation {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

export const analyzeAnthropicMessagesAffinity = async <Payload extends Pick<AnthropicMessagesPayload, 'messages'>>(
  payload: Payload,
  codec: Pick<AffinityCodec, 'unwrap'>,
): Promise<AffinityRequestAnalysis<Payload, AffinityCandidate>> => {
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

  const locationsByMessage = Map.groupBy(locations, location => location.messageIndex);
  return defineAffinityRequest([], candidate => {
    const messages = [...locationsByMessage].map(([messageIndex, messageLocations]) => {
      const { content } = payload.messages[messageIndex];
      if (!Array.isArray(content)) throw new Error('Anthropic Messages affinity expected content blocks');
      const projections = new Map(messageLocations.map(({ blockIndex, decoded }) => [blockIndex, projectOptionalAffinityBlob(decoded, candidate)]));
      // Thinking can only be replayed with its original upstream signature.
      // https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking#preserving-thinking-blocks
      const dropped = incompatibleReasoningParts(content, projections, block => block.type === 'thinking');
      return { messageIndex, projections, dropped };
    });
    const projections = messages.flatMap(message => [...message.projections.values()]);
    return {
      kind: 'accepted',
      degrades: messages.some(message => message.dropped.size > 0) || projections.some(projection => projection.kind === 'remove' && projection.degrades),
      preferred: projections.every(projection => projection.preferred),
      materialize: () => {
        const candidatePayload = structuredClone(payload);
        const emptiedByAffinity = new Set<number>();
        for (const { messageIndex, projections, dropped } of messages) {
          const message = candidatePayload.messages[messageIndex] as { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] };
          message.content = message.content.flatMap<AnthropicMessagesAssistantContentBlock>((block, blockIndex) => {
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
          if (message.content.length === 0) emptiedByAffinity.add(messageIndex);
        }
        candidatePayload.messages = candidatePayload.messages.filter((_message, messageIndex) => !emptiedByAffinity.has(messageIndex));
        return candidatePayload;
      },
    };
  });
};
