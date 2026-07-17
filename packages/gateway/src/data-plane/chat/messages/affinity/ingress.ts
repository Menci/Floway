import { type AffinityCodec, blobForExactCandidate, preferredAffinityEvidence, type DecodedAffinityBlob, type PreparedAffinityPayload } from '../../shared/affinity/index.ts';
import type { MessagesAssistantContentBlock, MessagesPayload } from '@floway-dev/protocols/messages';

interface MessagesBlobLocation {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly kind: 'thinking' | 'redacted_thinking';
  readonly decoded: DecodedAffinityBlob;
}

export const prepareMessagesAffinity = async (
  payload: MessagesPayload,
  codec: AffinityCodec,
): Promise<PreparedAffinityPayload<MessagesPayload>> => {
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

  return {
    routingEvidence: preferredAffinityEvidence(locations.map(location => location.decoded)),
    payloadForCandidate: candidate => {
      const candidatePayload = structuredClone(payload);
      const byMessage = Map.groupBy(locations, location => location.messageIndex);
      const emptiedByAffinity = new Set<number>();
      for (const [messageIndex, messageLocations] of byMessage) {
        const message = candidatePayload.messages[messageIndex];
        if (message.role !== 'assistant' || !Array.isArray(message.content)) {
          throw new Error('Messages affinity location no longer points to assistant block content');
        }
        const replacements = new Map<number, MessagesAssistantContentBlock | null>();
        for (const location of messageLocations) {
          const block = message.content[location.blockIndex];
          const selected = blobForExactCandidate(location.decoded, candidate);
          if (location.kind === 'thinking') {
            if (block.type !== 'thinking') throw new Error('Messages affinity thinking location changed type');
            const replacement = { ...block };
            if (selected.present) replacement.signature = selected.value;
            else delete replacement.signature;
            replacements.set(location.blockIndex, replacement);
          } else {
            if (block.type !== 'redacted_thinking') throw new Error('Messages affinity redacted location changed type');
            replacements.set(location.blockIndex, selected.present ? { ...block, data: selected.value } : null);
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
};
