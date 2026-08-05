import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { MessagesAssistantContentBlock, MessagesPayload } from '@floway-dev/protocols/messages';

interface MessagesBlobLocation {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly kind: 'thinking' | 'redacted_thinking';
  readonly decoded: DecodedAffinityBlob;
}

export const analyzeMessagesAffinity = async (
  payload: MessagesPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<MessagesPayload>> => {
  const locations: MessagesBlobLocation[] = [];
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type === 'thinking' && typeof block.signature === 'string') {
        locations.push({ messageIndex, blockIndex, kind: block.type, decoded: await codec.unwrap(block.signature, 'messages.thinking.signature') });
      } else if (block.type === 'redacted_thinking') {
        locations.push({ messageIndex, blockIndex, kind: block.type, decoded: await codec.unwrap(block.data, 'messages.redacted_thinking.data') });
      }
    }
  }

  return defineAffinityRequest([], candidate => {
    const projections = locations.map(location => ({ location, projection: projectOptionalAffinityBlob(location.decoded, candidate) }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      materialize: () => {
        const candidatePayload = structuredClone(payload);
        const byMessage = Map.groupBy(projections, item => item.location.messageIndex);
        const emptiedByAffinity = new Set<number>();
        for (const [messageIndex, messageProjections] of byMessage) {
          const message = candidatePayload.messages[messageIndex] as { role: 'assistant'; content: MessagesAssistantContentBlock[] };
          const replacements = new Map<number, MessagesAssistantContentBlock | null>();
          for (const { location, projection } of messageProjections) {
            const block = message.content[location.blockIndex];
            if (location.kind === 'thinking') {
              const replacement = { ...block } as Extract<MessagesAssistantContentBlock, { type: 'thinking' }>;
              if (projection.kind === 'preserve') replacement.signature = projection.value;
              else if (projection.kind === 'remove') delete replacement.signature;
              replacements.set(location.blockIndex, replacement);
            } else {
              replacements.set(
                location.blockIndex,
                projection.kind === 'preserve'
                  ? { ...block, type: 'redacted_thinking', data: projection.value }
                  : null,
              );
            }
          }
          message.content = message.content.flatMap((block, blockIndex) => {
            const replacement = replacements.get(blockIndex);
            return replacement === undefined ? [block] : replacement === null ? [] : [replacement];
          });
          if (message.content.length === 0) emptiedByAffinity.add(messageIndex);
        }
        candidatePayload.messages = candidatePayload.messages.filter((_message, messageIndex) => !emptiedByAffinity.has(messageIndex));
        return candidatePayload;
      },
    };
  });
};
