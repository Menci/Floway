import { type AffinityCodec, blobForCandidate, blobForForcedCandidate, type AffinityEvidence, type AffinityTarget, type DecodedAffinityBlob, type PreparedAffinityPayload } from '../../shared/affinity/index.ts';
import { createTemporaryResponsesItemId, hashResponsesItemBinding } from '../items/format.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';

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

interface ValidatedBoundCarrier {
  readonly decoded: Extract<DecodedAffinityBlob, { kind: 'owned' }>;
  readonly boundItem: NonNullable<AffinityTarget['boundItem']>;
}

const isOwnedLocation = (location: ResponsesBlobLocation): location is OwnedResponsesBlobLocation =>
  location.decoded.kind === 'owned';

export class ResponsesAffinityInputError extends Error {
  readonly param: string;

  constructor(message: string, param: string) {
    super(message);
    this.name = 'ResponsesAffinityInputError';
    this.param = param;
  }
}

export interface PreparedResponsesAffinity extends PreparedAffinityPayload<CanonicalResponsesPayload> {
  readonly itemIdMapForCandidate: (candidate: ModelCandidate) => ReadonlyMap<string, string>;
}

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

const opaqueBlobLocations = async (
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
): Promise<PreparedResponsesAffinity> => {
  const locations = await opaqueBlobLocations(payload.input, codec);
  const boundItems = new Map<number, ValidatedBoundCarrier>();
  for (const location of locations) {
    if (!isOwnedLocation(location)) continue;
    const affinity = location.decoded.envelope.affinity;
    const bound = affinity.boundItem;
    if (bound === undefined) continue;
    const itemIndex = location.itemIndex + 1;
    const item = payload.input[itemIndex];
    if (
      item === undefined
      || item.type !== bound.type
      || !('id' in item)
      || typeof item.id !== 'string'
      || await hashResponsesItemBinding(item) !== bound.contentHash
    ) {
      throw new ResponsesAffinityInputError(
        `Affinity carrier does not match the Responses input item at index ${itemIndex}.`,
        `input[${itemIndex}]`,
      );
    }
    if (boundItems.has(itemIndex)) {
      throw new ResponsesAffinityInputError(
        `Multiple affinity carriers bind Responses input item at index ${itemIndex}.`,
        `input[${itemIndex}]`,
      );
    }
    boundItems.set(itemIndex, { decoded: location.decoded, boundItem: bound });
  }

  const preparedByCandidate = new WeakMap<ModelCandidate, {
    readonly payload: CanonicalResponsesPayload;
    readonly itemIdMap: ReadonlyMap<string, string>;
  }>();
  const prepareCandidate = (candidate: ModelCandidate) => {
    const cached = preparedByCandidate.get(candidate);
    if (cached !== undefined) return cached;
    const itemIdMap = new Map<string, string>();
    const recordItemId = (item: ResponsesInputItem, id: string): void => {
      if (!('id' in item) || typeof item.id !== 'string') {
        throw new Error('Responses affinity item ID changed before candidate preparation');
      }
      if (item.id !== id) itemIdMap.set(item.id, id);
      item.id = id;
    };
    const candidatePayload = structuredClone(payload);
    for (const [itemIndex, carrier] of boundItems) {
      const item = candidatePayload.input[itemIndex];
      if (item === undefined) throw new Error('Validated Responses affinity item disappeared before candidate preparation');
      const selected = itemRequiresAffinity(item)
        ? blobForForcedCandidate(carrier.decoded, candidate)
        : blobForCandidate(carrier.decoded, candidate);
      recordItemId(
        item,
        selected.compatible ? carrier.boundItem.upstreamItemId : createTemporaryResponsesItemId(item.type),
      );
    }
    const byItem = Map.groupBy(locations, location => location.itemIndex);
    const rewritten = candidatePayload.input.flatMap((item, itemIndex): ResponsesInputItem[] => {
      const itemLocations = byItem.get(itemIndex);
      if (itemLocations === undefined) return [item];
      let removeItem = false;
      const replacement = { ...item } as ResponsesInputItem & Record<string, unknown>;
      const decisions = itemLocations.map(location => ({
        location,
        selected: itemRequiresAffinity(item)
          ? blobForForcedCandidate(location.decoded, candidate)
          : blobForCandidate(location.decoded, candidate),
      }));
      for (const { location, selected } of decisions) {
        if (location.contentIndex !== undefined) continue;
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
      }
      const nested = new Map(decisions.flatMap(decision =>
        decision.location.contentIndex === undefined ? [] : [[decision.location.contentIndex, decision] as const]));
      const removedSyntheticNested = [...nested.values()].some(decision =>
        decision.location.decoded.kind === 'owned'
        && decision.location.decoded.value === undefined
        && !decision.selected.present);
      if (nested.size > 0) {
        if (replacement.type !== 'agent_message') throw new Error('Responses affinity content location changed item type');
        replacement.content = replacement.content.flatMap((content, contentIndex) => {
          const decision = nested.get(contentIndex);
          if (decision === undefined) return [content];
          if (content.type !== 'encrypted_content') throw new Error('Responses affinity content location changed block type');
          return decision.selected.present ? [{ ...content, encrypted_content: decision.selected.value }] : [];
        });
      }
      const compatibleOwned = decisions.find(decision => decision.selected.compatible && decision.location.decoded.kind === 'owned');
      if (compatibleOwned?.location.decoded.kind === 'owned') {
        const upstreamItemId = compatibleOwned.location.decoded.envelope.affinity.upstreamItemId;
        if (upstreamItemId !== undefined && 'id' in replacement && typeof replacement.id === 'string') {
          recordItemId(replacement, upstreamItemId);
        }
      } else if (decisions.some(decision => decision.location.decoded.kind === 'owned') && 'id' in replacement && typeof replacement.id === 'string') {
        recordItemId(
          replacement,
          createTemporaryResponsesItemId(replacement.type),
        );
      }
      if (removeItem) return [];
      if (replacement.type === 'agent_message' && replacement.content.length === 0 && !removedSyntheticNested) return [];
      return [replacement];
    });
    const prepared = { payload: { ...candidatePayload, input: rewritten }, itemIdMap };
    preparedByCandidate.set(candidate, prepared);
    return prepared;
  };

  return {
    routingEvidence: routingEvidenceFrom(payload.input, locations),
    payloadForCandidate: candidate => structuredClone(prepareCandidate(candidate).payload),
    itemIdMapForCandidate: candidate => new Map(prepareCandidate(candidate).itemIdMap),
  };
};
