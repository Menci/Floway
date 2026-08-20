import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { withIndexesChanged, withKeysChanged } from '@floway-dev/protocols/common';

interface AnthropicMessagesBlobLocation {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly kind: 'thinking' | 'redacted_thinking';
  readonly decoded: DecodedAffinityBlob;
}

export const analyzeAnthropicMessagesAffinity = async (
  payload: AnthropicMessagesPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<AnthropicMessagesPayload>> => {
  const locations: AnthropicMessagesBlobLocation[] = [];
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type === 'thinking' && typeof block.signature === 'string') {
        locations.push({ messageIndex, blockIndex, kind: block.type, decoded: await codec.unwrap(block.signature, 'anthropic-messages.thinking.signature') });
      } else if (block.type === 'redacted_thinking') {
        locations.push({ messageIndex, blockIndex, kind: block.type, decoded: await codec.unwrap(block.data, 'anthropic-messages.redacted_thinking.data') });
      }
    }
  }

  return defineAffinityRequest([], candidate => {
    const projections = locations.map(location => ({ location, projection: projectOptionalAffinityBlob(location.decoded, candidate) }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      // Rebuilt rather than cloned: the payload is the record's, so it is frozen, and a message
      // no projection touches rides through by identity. What one candidate is owed differs from
      // what the next is by a handful of objects, not by a copy of the conversation.
      materialize: () => {
        const byMessage = Map.groupBy(projections, item => item.location.messageIndex);
        const emptiedByAffinity = new Set<number>();
        const rewritten = new Map<number, AnthropicMessagesPayload['messages'][number]>();
        for (const [messageIndex, messageProjections] of byMessage) {
          const message = payload.messages[messageIndex] as { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] };
          const replacements = new Map<number, AnthropicMessagesAssistantContentBlock | null>();
          for (const { location, projection } of messageProjections) {
            const block = message.content[location.blockIndex];
            if (location.kind === 'thinking') {
              replacements.set(location.blockIndex, withKeysChanged(block, {
                signature: projection.kind === 'preserve' ? projection.value : undefined,
              }));
            } else {
              replacements.set(
                location.blockIndex,
                projection.kind === 'preserve'
                  ? { ...block, type: 'redacted_thinking', data: projection.value }
                  : null,
              );
            }
          }
          const content = withIndexesChanged(message.content, replacements);
          if (content.length === 0) emptiedByAffinity.add(messageIndex);
          rewritten.set(messageIndex, withKeysChanged(message, { content }) as AnthropicMessagesPayload['messages'][number]);
        }
        const messages = payload.messages
          .map((message, messageIndex) => rewritten.get(messageIndex) ?? message)
          .filter((_message, messageIndex) => !emptiedByAffinity.has(messageIndex));
        return withKeysChanged(payload, { messages });
      },
    };
  });
};
