import { responsesAffinityDomain } from './domain.ts';
import type { AffinityCodec } from '../../shared/affinity/codec.ts';
import { blobForCandidate, type PreparedAffinityPayload } from '../../shared/affinity/prepared.ts';
import type { AffinityEvidence, AffinityTarget, DecodedAffinityBlob } from '../../shared/affinity/types.ts';
import { createTemporaryResponsesItemId } from '../items/format.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

interface ResponsesBlobLocation {
  readonly itemIndex: number;
  readonly contentIndex?: number;
  readonly decoded: DecodedAffinityBlob;
}

type OwnedResponsesBlobLocation = ResponsesBlobLocation & {
  readonly decoded: Extract<DecodedAffinityBlob, { kind: 'owned' }>;
};

const isOwnedLocation = (location: ResponsesBlobLocation): location is OwnedResponsesBlobLocation =>
  location.decoded.kind === 'owned';

const itemRequiresAffinity = (item: ResponsesInputItem): boolean =>
  item.type === 'compaction'
  || item.type === 'context_compaction'
  || item.type === 'program'
  || item.type === 'program_output';

const routingEvidenceFrom = (
  items: readonly ResponsesInputItem[],
  locations: readonly ResponsesBlobLocation[],
): AffinityEvidence[] => {
  const ownedByItem = Map.groupBy(
    locations.filter(isOwnedLocation),
    location => location.itemIndex,
  );
  const evidence: AffinityEvidence[] = [];
  const forceItemsWithoutPriorTarget: number[] = [];
  let latestTarget: AffinityTarget | undefined;

  for (const [itemIndex, item] of items.entries()) {
    const owned = ownedByItem.get(itemIndex) ?? [];
    for (const location of owned) {
      latestTarget = location.decoded.envelope.affinity;
      evidence.push({ target: latestTarget, mode: itemRequiresAffinity(item) ? 'force' : 'prefer' });
    }
    if (!itemRequiresAffinity(item) || owned.length > 0) continue;
    if (latestTarget !== undefined) evidence.push({ target: latestTarget, mode: 'force' });
    else forceItemsWithoutPriorTarget.push(itemIndex);
  }

  for (const itemIndex of forceItemsWithoutPriorTarget) {
    const followingSynthetic = locations.find(location =>
      location.itemIndex > itemIndex
      && location.decoded.kind === 'owned'
      && location.decoded.envelope.affinity.syntheticItem === true);
    if (followingSynthetic?.decoded.kind === 'owned') {
      evidence.push({ target: followingSynthetic.decoded.envelope.affinity, mode: 'force' });
    }
  }

  return evidence;
};

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
    routingEvidence: routingEvidenceFrom(payload.input, locations),
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
