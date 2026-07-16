import type { AffinityCodec, AffinityEvidence, AffinityTarget, DecodedAffinityBlob, blobForCandidate, type PreparedAffinityPayload  } from '../../shared/affinity/index.ts';
import { createTemporaryResponsesItemId } from '../items/format.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

interface ResponsesBlobLocation {
  readonly itemIndex: number;
  readonly slot: string;
  readonly contentIndex?: number;
  readonly decoded: DecodedAffinityBlob;
}

const carrierDomain = (itemType: string, slot: string): string => `responses.${itemType}.${slot}`;

type OwnedResponsesBlobLocation = ResponsesBlobLocation & {
  readonly decoded: Extract<DecodedAffinityBlob, { kind: 'owned' }>;
};

const isOwnedLocation = (location: ResponsesBlobLocation): location is OwnedResponsesBlobLocation =>
  location.decoded.kind === 'owned';

const itemRequiresAffinity = (item: ResponsesInputItem): boolean =>
  ['compaction', 'compaction_summary', 'context_compaction', 'program', 'program_output'].includes(item.type);

const routingEvidenceFrom = (
  items: readonly ResponsesInputItem[],
  locations: readonly ResponsesBlobLocation[],
): AffinityEvidence[] => {
  const ownedByItem = Map.groupBy(
    locations.filter(isOwnedLocation),
    location => location.itemIndex,
  );
  const evidence: AffinityEvidence[] = [];
  let latestTarget: AffinityTarget | undefined;

  for (const [itemIndex, item] of items.entries()) {
    const owned = ownedByItem.get(itemIndex) ?? [];
    for (const location of owned) {
      latestTarget = location.decoded.envelope.affinity;
      evidence.push({ target: latestTarget, mode: 'prefer' });
      if (itemRequiresAffinity(item)) evidence.push({ target: latestTarget, mode: 'force' });
    }
    if (!itemRequiresAffinity(item) || owned.length > 0) continue;
    if (latestTarget !== undefined) evidence.push({ target: latestTarget, mode: 'force' });
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
      locations.push({ itemIndex, slot: 'encrypted_content', decoded: await codec.unwrap(topLevel, carrierDomain(item.type, 'encrypted_content')) });
    }
    if (item.type === 'program' && typeof item.fingerprint === 'string') {
      locations.push({ itemIndex, slot: 'fingerprint', decoded: await codec.unwrap(item.fingerprint, carrierDomain(item.type, 'fingerprint')) });
    }
    if (item.type !== 'agent_message') continue;
    for (const [contentIndex, content] of item.content.entries()) {
      if (content.type !== 'encrypted_content' || typeof content.encrypted_content !== 'string') continue;
      locations.push({
        itemIndex,
        slot: `content.${contentIndex}.encrypted_content`,
        contentIndex,
        decoded: await codec.unwrap(content.encrypted_content, carrierDomain(item.type, `content.${contentIndex}.encrypted_content`)),
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
  const boundItems = new Map<number, Extract<DecodedAffinityBlob, { kind: 'owned' }>['envelope']['affinity']>();
  for (const location of locations) {
    if (location.decoded.kind === 'owned' && location.decoded.envelope.affinity.boundItem !== undefined) {
      boundItems.set(location.itemIndex + 1, location.decoded.envelope.affinity);
    }
  }
  return {
    routingEvidence: routingEvidenceFrom(payload.input, locations),
    payloadForCandidate: candidate => {
      const candidatePayload = structuredClone(payload);
      for (const [itemIndex, affinity] of boundItems) {
        const item = candidatePayload.input[itemIndex];
        const bound = affinity.boundItem;
        if (item === undefined || bound === undefined || item.type !== bound.type || !('id' in item) || typeof item.id !== 'string') continue;
        item.id = candidate.provider.upstream === affinity.upstreamId && candidate.model.id === affinity.modelId
          ? bound.upstreamItemId
          : createTemporaryResponsesItemId(item.type);
      }
      const byItem = Map.groupBy(locations, location => location.itemIndex);
      const rewritten = candidatePayload.input.flatMap((item, itemIndex): ResponsesInputItem[] => {
        const itemLocations = byItem.get(itemIndex);
        if (itemLocations === undefined) return [item];
        let removeItem = false;
        const replacement = { ...item } as ResponsesInputItem & Record<string, unknown>;
        const decisions = itemLocations.map(location => ({ location, selected: blobForCandidate(location.decoded, candidate) }));
        for (const { location, selected } of decisions) {
          if (location.contentIndex === undefined) {
            if (selected.present) {
              replacement[location.slot] = selected.value;
            } else {
              delete replacement[location.slot];
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
