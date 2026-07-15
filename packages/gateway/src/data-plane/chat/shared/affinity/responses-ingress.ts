import { responsesAffinityDomain } from './carrier-domains.ts';
import type { AffinityCodec } from './codec.ts';
import { blobForCandidate, ownedAffinities, type PreparedAffinityPayload } from './prepared.ts';
import type { DecodedAffinityBlob } from './types.ts';
import { createTemporaryResponsesItemId } from '../responses/items/format.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

interface ResponsesBlobLocation {
  readonly itemIndex: number;
  readonly contentIndex?: number;
  readonly decoded: DecodedAffinityBlob;
}

const encryptedContentLocations = async (
  items: readonly ResponsesInputItem[],
  codec: AffinityCodec,
): Promise<ResponsesBlobLocation[]> => {
  const locations: ResponsesBlobLocation[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const topLevel = (item as { encrypted_content?: unknown }).encrypted_content;
    if (typeof topLevel === 'string') {
      locations.push({ itemIndex, decoded: await codec.unwrap(topLevel, responsesAffinityDomain(item.type, 'encrypted_content')) });
    }
    if (item.type !== 'agent_message') continue;
    for (const [contentIndex, content] of item.content.entries()) {
      if (content.type !== 'encrypted_content' || typeof content.encrypted_content !== 'string') continue;
      locations.push({
        itemIndex,
        contentIndex,
        decoded: await codec.unwrap(content.encrypted_content, responsesAffinityDomain(item.type, `content.${contentIndex}.encrypted_content`)),
      });
    }
  }
  return locations;
};

export const prepareResponsesAffinity = async (
  payload: CanonicalResponsesPayload,
  codec: AffinityCodec,
): Promise<PreparedAffinityPayload<CanonicalResponsesPayload>> => {
  const locations = await encryptedContentLocations(payload.input, codec);
  return {
    affinities: ownedAffinities(locations.map(location => location.decoded)),
    payloadForCandidate: candidate => {
      const candidatePayload = structuredClone(payload);
      const byItem = Map.groupBy(locations, location => location.itemIndex);
      const rewritten = candidatePayload.input.flatMap((item, itemIndex): ResponsesInputItem[] => {
        const itemLocations = byItem.get(itemIndex);
        if (itemLocations === undefined) return [item];
        let removeItem = false;
        const replacement = { ...item } as ResponsesInputItem & { encrypted_content?: string };
        const decisions = itemLocations.map(location => ({ location, selected: blobForCandidate(location.decoded, candidate) }));
        for (const { location, selected } of decisions) {
          if (location.contentIndex === undefined) {
            if (selected.present) {
              replacement.encrypted_content = selected.value;
            } else {
              delete replacement.encrypted_content;
              if (
                location.decoded.kind === 'owned'
                && location.decoded.value === undefined
                && location.decoded.envelope.affinity.syntheticItem === true
              ) removeItem = true;
            }
            continue;
          }
          if (replacement.type !== 'agent_message') throw new Error('Responses affinity content location changed item type');
          replacement.content = replacement.content.flatMap((content, contentIndex) => {
            if (contentIndex !== location.contentIndex) return [content];
            if (content.type !== 'encrypted_content') throw new Error('Responses affinity content location changed block type');
            return selected.present ? [{ ...content, encrypted_content: selected.value }] : [];
          });
        }
        const compatibleOwned = decisions.find(decision => decision.selected.compatible && decision.location.decoded.kind === 'owned');
        if (compatibleOwned?.location.decoded.kind === 'owned') {
          const upstreamItemId = compatibleOwned.location.decoded.envelope.affinity.upstreamItemId;
          if (upstreamItemId !== undefined) replacement.id = upstreamItemId;
        } else if (decisions.some(decision => decision.location.decoded.kind === 'owned') && 'id' in replacement && typeof replacement.id === 'string') {
          replacement.id = createTemporaryResponsesItemId(replacement.type);
        }
        if (removeItem) return [];
        if (replacement.type === 'agent_message' && replacement.content.length === 0) return [];
        return [replacement];
      });
      return { ...candidatePayload, input: rewritten };
    },
  };
};
