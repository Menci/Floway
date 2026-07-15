import { CHAT_COMPLETIONS_AFFINITY_DOMAIN } from './carrier-domains.ts';
import type { AffinityCodec } from './codec.ts';
import { blobForCandidate, ownedAffinities, type PreparedAffinityPayload } from './prepared.ts';
import type { DecodedAffinityBlob } from './types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

export const prepareChatCompletionsAffinity = async (
  payload: ChatCompletionsPayload,
  codec: AffinityCodec,
): Promise<PreparedAffinityPayload<ChatCompletionsPayload>> => {
  const decoded = new Map<number, DecodedAffinityBlob>();
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant' || typeof message.reasoning_opaque !== 'string') continue;
    decoded.set(index, await codec.unwrap(message.reasoning_opaque, CHAT_COMPLETIONS_AFFINITY_DOMAIN));
  }

  return {
    affinities: ownedAffinities(decoded.values()),
    payloadForCandidate: candidate => {
      const candidatePayload = structuredClone(payload);
      for (const [index, blob] of decoded) {
        const message = candidatePayload.messages[index];
        const selected = blobForCandidate(blob, candidate);
        if (selected.present) message.reasoning_opaque = selected.value;
        else delete message.reasoning_opaque;
      }
      return candidatePayload;
    },
  };
};
