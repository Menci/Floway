import { cloneDeep } from 'es-toolkit';

import { reasoningAffinitySlots, type ReasoningAffinitySlot } from './reasoning.ts';
import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { OpenAIChatCompletionsPayload, ReasoningRecord } from '@floway-dev/protocols/openai-chat-completions';

export const analyzeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<OpenAIChatCompletionsPayload>> => {
  const decoded: { messageIndex: number; slot: ReasoningAffinitySlot; blob: DecodedAffinityBlob }[] = [];
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (message.role !== 'assistant') continue;
    for (const slot of reasoningAffinitySlots(message)) decoded.push({ messageIndex, slot, blob: await codec.unwrap(slot.value, slot.domain) });
  }
  return defineAffinityRequest([], candidate => {
    const projections = decoded.map(item => ({ ...item, projection: projectOptionalAffinityBlob(item.blob, candidate) }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      preferred: projections.every(item => item.projection.preferred),
      materialize: () => {
        // XXX: Keep enumerable Symbols through request cloning until immutable pipelines own this boundary.
        const candidatePayload = cloneDeep(payload);
        const removedMembers = new Map<ReasoningRecord[], Set<number>>();
        for (const { messageIndex, slot, projection, blob } of projections) {
          const message = candidatePayload.messages[messageIndex] as unknown as Record<string, unknown>;
          if (slot.index === undefined) {
            if (projection.kind === 'preserve') message[slot.field] = projection.value;
            else delete message[slot.field];
          } else {
            const members = message[slot.field] as ReasoningRecord[];
            if (projection.kind === 'preserve') members[slot.index][slot.key!] = projection.value;
            else if (blob.kind === 'owned' && blob.syntheticItem === true) {
              const indexes = removedMembers.get(members) ?? new Set<number>();
              indexes.add(slot.index);
              removedMembers.set(members, indexes);
            } else delete members[slot.index][slot.key!];
          }
        }
        for (const [members, indexes] of removedMembers) {
          for (const index of [...indexes].sort((a, b) => b - a)) members.splice(index, 1);
        }
        return candidatePayload;
      },
    };
  });
};
