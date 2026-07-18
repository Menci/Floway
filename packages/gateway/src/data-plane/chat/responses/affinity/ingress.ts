import { type AffinityCodec, blobForExactCandidate, blobForForcedCandidate, type AffinityEvidence, type AffinityTarget, type DecodedAffinityBlob, type PreparedAffinityPayload } from '../../shared/affinity/index.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';

interface ResponsesBlobLocation {
  readonly itemIndex: number;
  readonly slot: string;
  readonly contentIndex?: number;
  readonly decoded: DecodedAffinityBlob;
}

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalItemType(itemType)}.${slot}`;

const isOwnedLocation = (
  location: ResponsesBlobLocation,
): location is ResponsesBlobLocation & { readonly decoded: Extract<DecodedAffinityBlob, { kind: 'owned' }> } =>
  location.decoded.kind === 'owned';

const itemInheritsForce = (item: ResponsesInputItem): boolean =>
  ['compaction', 'compaction_summary', 'program', 'program_output'].includes(item.type);

const blobRequiresForce = (item: ResponsesInputItem, decoded: DecodedAffinityBlob): boolean =>
  item.type === 'context_compaction'
    ? decoded.kind === 'owned' && decoded.value !== undefined
    : itemInheritsForce(item);

const routingEvidenceFrom = (
  items: readonly ResponsesInputItem[],
  locations: readonly ResponsesBlobLocation[],
): AffinityEvidence[] => {
  const locationsByItem = Map.groupBy(locations, location => location.itemIndex);
  const evidence: AffinityEvidence[] = [];
  let latestTarget: AffinityTarget | undefined;

  for (const [itemIndex, item] of items.entries()) {
    const itemLocations = locationsByItem.get(itemIndex) ?? [];
    for (const location of itemLocations.filter(isOwnedLocation)) {
      latestTarget = location.decoded.affinity;
      evidence.push({ target: latestTarget, mode: 'prefer' });
      if (blobRequiresForce(item, location.decoded)) evidence.push({ target: latestTarget, mode: 'force' });
    }
    if (itemInheritsForce(item) && itemLocations.length === 0 && latestTarget !== undefined) {
      evidence.push({ target: latestTarget, mode: 'force' });
    }
  }

  return evidence;
};

const opaqueBlobLocations = async (
  items: readonly ResponsesInputItem[],
  codec: AffinityCodec,
): Promise<ResponsesBlobLocation[]> => {
  const locations: ResponsesBlobLocation[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const topLevel = (item as { encrypted_content?: unknown }).encrypted_content;
    if (typeof topLevel === 'string') {
      locations.push({
        itemIndex,
        slot: 'encrypted_content',
        decoded: await codec.unwrap(topLevel, carrierDomain(item.type, 'encrypted_content')),
      });
    }
    if (item.type === 'program' && typeof item.fingerprint === 'string') {
      locations.push({
        itemIndex,
        slot: 'fingerprint',
        decoded: await codec.unwrap(item.fingerprint, carrierDomain(item.type, 'fingerprint')),
      });
    }
    if (item.type !== 'agent_message') continue;
    for (const [contentIndex, content] of item.content.entries()) {
      if (content.type !== 'encrypted_content' || typeof content.encrypted_content !== 'string') continue;
      locations.push({
        itemIndex,
        slot: `content.${contentIndex}.encrypted_content`,
        contentIndex,
        decoded: await codec.unwrap(
          content.encrypted_content,
          carrierDomain(item.type, `content.${contentIndex}.encrypted_content`),
        ),
      });
    }
  }
  return locations;
};

const isEmptyOriginlessReasoningCarrier = (
  item: ResponsesInputItem & Record<string, unknown>,
  decisions: readonly {
    readonly location: ResponsesBlobLocation;
    readonly selected: ReturnType<typeof blobForExactCandidate>;
  }[],
): boolean => {
  if (item.type !== 'reasoning' || !Array.isArray(item.summary) || item.summary.length !== 0) return false;
  const originlessTopLevel = decisions.some(({ location, selected }) =>
    location.contentIndex === undefined
    && location.slot === 'encrypted_content'
    && location.decoded.kind === 'owned'
    && location.decoded.value === undefined
    && !selected.present);
  if (!originlessTopLevel) return false;
  return Object.keys(item).every(key => ['type', 'id', 'summary', 'encrypted_content'].includes(key));
};

export const prepareResponsesAffinity = async (
  payload: CanonicalResponsesPayload,
  codec: AffinityCodec,
): Promise<PreparedAffinityPayload<CanonicalResponsesPayload>> => {
  const locations = await opaqueBlobLocations(payload.input, codec);

  return {
    routingEvidence: routingEvidenceFrom(payload.input, locations),
    payloadForCandidate: candidate => {
      const candidatePayload = structuredClone(payload);
      const byItem = Map.groupBy(locations, location => location.itemIndex);
      candidatePayload.input = candidatePayload.input.flatMap((item, itemIndex): ResponsesInputItem[] => {
        const itemLocations = byItem.get(itemIndex);
        if (itemLocations === undefined) return [item];

        const replacement = { ...item } as ResponsesInputItem & Record<string, unknown>;
        const decisions = itemLocations.map(location => ({
          location,
          selected: blobRequiresForce(item, location.decoded)
            ? blobForForcedCandidate(location.decoded, candidate)
            : blobForExactCandidate(location.decoded, candidate),
        }));

        for (const { location, selected } of decisions) {
          if (location.contentIndex !== undefined) continue;
          if (selected.present) replacement[location.slot] = selected.value;
          else delete replacement[location.slot];
        }

        if (item.type === 'agent_message') {
          const nested = new Map(decisions.flatMap(decision =>
            decision.location.contentIndex === undefined ? [] : [[decision.location.contentIndex, decision] as const]));
          const agentMessage = replacement as Extract<ResponsesInputItem, { type: 'agent_message' }>;
          agentMessage.content = agentMessage.content.flatMap((content, contentIndex) => {
            const decision = nested.get(contentIndex);
            if (decision === undefined) return [content];
            return decision.selected.present
              ? [{ ...content, encrypted_content: decision.selected.value }]
              : [];
          });
        }

        return isEmptyOriginlessReasoningCarrier(replacement, decisions) ? [] : [replacement];
      });
      return candidatePayload;
    },
  };
};
