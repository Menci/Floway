import { type AffinityCodec, blobForExactCandidate, blobForForcedCandidate, type AffinityEvidence, type AffinityTarget, type DecodedAffinityBlob, type PreparedAffinityPayload } from '../../shared/affinity/index.ts';
import { canonicalResponsesItemType, createTemporaryResponsesItemId, hashResponsesItemBinding } from '../items/format.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';

interface ResponsesBlobLocation {
  readonly itemIndex: number;
  readonly slot: string;
  readonly contentIndex?: number;
  readonly decoded: DecodedAffinityBlob;
}

const carrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalResponsesItemType(itemType)}.${slot}`;

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
    const owned = itemLocations.filter(isOwnedLocation);
    for (const location of owned) {
      latestTarget = location.decoded.affinity;
      evidence.push({ target: latestTarget, mode: 'prefer' });
      if (blobRequiresForce(item, location.decoded)) evidence.push({ target: latestTarget, mode: 'force' });
    }
    if (!itemInheritsForce(item) || itemLocations.length > 0) continue;
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
    const affinity = location.decoded.affinity;
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
    const setItemId = (item: ResponsesInputItem, id: string): void => {
      const existingId = 'id' in item && typeof item.id === 'string' ? item.id : undefined;
      if (existingId !== undefined && existingId !== id) itemIdMap.set(existingId, id);
      (item as ResponsesInputItem & { id: string }).id = id;
    };
    const candidatePayload = structuredClone(payload);
    for (const [itemIndex, carrier] of boundItems) {
      const item = candidatePayload.input[itemIndex]!;
      const selected = blobRequiresForce(item, carrier.decoded)
        ? blobForForcedCandidate(carrier.decoded, candidate)
        : blobForExactCandidate(carrier.decoded, candidate);
      if (!selected.compatible) setItemId(item, createTemporaryResponsesItemId(item.type));
      else if (carrier.boundItem.upstreamItemId !== undefined) setItemId(item, carrier.boundItem.upstreamItemId);
      else delete (item as ResponsesInputItem & { id?: string }).id;
    }
    const byItem = Map.groupBy(locations, location => location.itemIndex);
    const rewritten = candidatePayload.input.flatMap((item, itemIndex): ResponsesInputItem[] => {
      const itemLocations = byItem.get(itemIndex);
      if (itemLocations === undefined) return [item];
      let removeItem = false;
      const replacement = { ...item } as ResponsesInputItem & Record<string, unknown>;
      const decisions = itemLocations.map(location => ({
        location,
        selected: blobRequiresForce(item, location.decoded)
          ? blobForForcedCandidate(location.decoded, candidate)
          : blobForExactCandidate(location.decoded, candidate),
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
            && location.decoded.affinity.syntheticItem === true
          ) removeItem = true;
        }
      }
      const nested = new Map(decisions.flatMap(decision =>
        decision.location.contentIndex === undefined ? [] : [[decision.location.contentIndex, decision] as const]));
      const removedOriginlessNestedCarrier = [...nested.values()].some(decision =>
        decision.location.decoded.kind === 'owned'
        && decision.location.decoded.value === undefined
        && !decision.selected.present);
      if (nested.size > 0) {
        const agentMessage = replacement as Extract<ResponsesInputItem, { type: 'agent_message' }>;
        agentMessage.content = agentMessage.content.flatMap((content, contentIndex) => {
          const decision = nested.get(contentIndex);
          if (decision === undefined) return [content];
          return decision.selected.present ? [{ ...content, encrypted_content: decision.selected.value }] : [];
        });
      }
      const compatibleOwned = decisions.find(decision => decision.selected.compatible && decision.location.decoded.kind === 'owned');
      if (compatibleOwned?.location.decoded.kind === 'owned') {
        const upstreamItemId = compatibleOwned.location.decoded.affinity.upstreamItemId;
        if (upstreamItemId !== undefined) setItemId(replacement, upstreamItemId);
        else delete replacement.id;
      } else if (decisions.some(decision => decision.location.decoded.kind === 'owned') && 'id' in replacement && typeof replacement.id === 'string') {
        setItemId(
          replacement,
          createTemporaryResponsesItemId(replacement.type),
        );
      }
      if (removeItem) return [];
      // An origin-less carrier can be the only added content on an otherwise
      // empty upstream agent_message. Removing that carrier must restore the
      // empty message rather than remove the upstream item itself.
      if (replacement.type === 'agent_message' && replacement.content.length === 0 && !removedOriginlessNestedCarrier) return [];
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
