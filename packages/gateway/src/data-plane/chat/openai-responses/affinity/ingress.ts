import {
  type AffinityCodec,
  type AffinityIdentity,
  type AffinityRequestAnalysis,
  affinityIdentityOf,
  candidateSatisfiesAffinityIdentity,
  type DecodedAffinityBlob,
  defineAffinityRequest,
  type OptionalAffinityBlobProjection,
  projectOptionalAffinityBlob,
  projectRequiredAffinityBlob,
} from '../../shared/affinity/index.ts';
import { isOpenAIResponsesCompactShimItem } from '../interceptors/compact-shim.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';

interface OpenAIResponsesBlobLocation {
  readonly itemIndex: number;
  readonly slot: string;
  readonly contentIndex?: number;
  readonly decoded: DecodedAffinityBlob;
}

interface OpenAIResponsesBlobAnalysis extends OpenAIResponsesBlobLocation {
  readonly required: boolean;
}

interface OpenAIResponsesItemAnalysis {
  readonly itemIndex: number;
  readonly synthetic: boolean;
  readonly blobs: readonly OpenAIResponsesBlobAnalysis[];
  readonly inheritedRequiredTarget?: AffinityIdentity;
}

interface OpenAIResponsesRequestAnalysis {
  readonly requiredTargets: readonly AffinityIdentity[];
  readonly items: readonly OpenAIResponsesItemAnalysis[];
}

interface OpenAIResponsesBlobCandidateProjection {
  readonly location: OpenAIResponsesBlobLocation;
  readonly projection: OptionalAffinityBlobProjection;
}

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `openai-responses.${canonicalItemType(itemType)}.${slot}`;

const itemInheritsRequiredTarget = (item: OpenAIResponsesInputItem): boolean =>
  !isOpenAIResponsesCompactShimItem(item)
  && ['compaction', 'compaction_summary', 'program', 'program_output'].includes(item.type);

const blobRequiresOriginalTarget = (item: OpenAIResponsesInputItem, decoded: DecodedAffinityBlob): boolean =>
  item.type === 'context_compaction'
    ? decoded.kind === 'owned' && decoded.value !== undefined
    : itemInheritsRequiredTarget(item);

// Keys that name an item rather than carry what it says. An item holding
// nothing but these has no content to send.
const itemEnvelopeKeys: ReadonlySet<string> = new Set(['type', 'id', 'status', 'created_by']);

// Whether dropping a payload-carrying blob left the item as a bare reference.
//
// An owned blob is what an upstream signed, against that item's id, so the two
// state one value: the blob is the payload, and the id is the name its owner
// files that payload under. Where affinity cannot replay the blob it deletes
// the slot, and for an item whose blob was the entire content that leaves an id
// pointing at nothing. Against an upstream that never stored it
// (`store: false`) the reference cannot resolve and the turn fails on it, as one
// live capture of a cross-upstream model switch did:
//
//   "Item with id 'rs_...' not found. Items are not persisted when `store` is
//    set to false. Try again with `store` set to true, or remove this item
//    from your input."
//
// The upstream named the remedy it accepts, and dropping the item is the only
// one this stage can take. An item that still says something (a readable
// summary, a call, a result) keeps its place, because there the carrier was an
// attachment and `degrades` already records that loss for candidate ordering.
//
// This is not the `syntheticItem` question. That marker answers "did Floway
// create this item", and is valid only without an `origin`, so it cannot
// describe the client's own item carrying a natural blob. What is asked here is
// narrower and still authenticated: the carrier held upstream-issued bytes,
// this candidate cannot replay them, and nothing else remains to send.
//
// A carrier that never held a value is out of scope by the same token: an
// originless blob is a routing marker we attached ourselves, dropping it loses
// nothing, and the item is left exactly as its owner sent it.
// https://github.com/openai/codex/blob/8c41ed33ce3e39460e7b13b14c35e0c39bb5980d/codex-rs/protocol/src/models.rs#L1076-L1094
const isOnlyCarrierReference = (item: Record<string, unknown>, discardedPayload: boolean): boolean =>
  discardedPayload
  && Object.entries(item).every(([key, value]) =>
    itemEnvelopeKeys.has(key)
    || value === undefined
    || value === null
    || (Array.isArray(value) && value.length === 0));

const opaqueBlobLocations = async (
  items: readonly OpenAIResponsesInputItem[],
  codec: AffinityCodec,
): Promise<OpenAIResponsesBlobLocation[]> => {
  const locations: OpenAIResponsesBlobLocation[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const topLevel = (item as { encrypted_content?: unknown }).encrypted_content;
    if (typeof topLevel === 'string' && !isOpenAIResponsesCompactShimItem(item)) {
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

const analyzeOpenAIResponsesRequest = (
  items: readonly OpenAIResponsesInputItem[],
  locations: readonly OpenAIResponsesBlobLocation[],
): OpenAIResponsesRequestAnalysis => {
  const locationsByItem = Map.groupBy(locations, location => location.itemIndex);
  const requiredTargets: AffinityIdentity[] = [];
  const itemAnalyses: OpenAIResponsesItemAnalysis[] = [];
  let latestOwnedTarget: AffinityIdentity | undefined;

  for (const [itemIndex, item] of items.entries()) {
    const itemLocations = locationsByItem.get(itemIndex) ?? [];
    const blobs = itemLocations.map(location => {
      const required = blobRequiresOriginalTarget(item, location.decoded);
      if (location.decoded.kind === 'owned') {
        latestOwnedTarget = affinityIdentityOf(location.decoded);
        if (required) requiredTargets.push(latestOwnedTarget);
      }
      return { ...location, required };
    });
    const inheritedRequiredTarget = itemInheritsRequiredTarget(item)
      && itemLocations.length === 0
      ? latestOwnedTarget
      : undefined;
    if (inheritedRequiredTarget !== undefined) requiredTargets.push(inheritedRequiredTarget);
    if (blobs.length === 0 && inheritedRequiredTarget === undefined) continue;

    itemAnalyses.push({
      itemIndex,
      synthetic: blobs.some(blob => blob.decoded.kind === 'owned' && blob.decoded.syntheticItem === true),
      blobs,
      ...(inheritedRequiredTarget !== undefined ? { inheritedRequiredTarget } : {}),
    });
  }

  return { requiredTargets, items: itemAnalyses };
};

const materializeOpenAIResponsesPayload = (
  payload: CanonicalOpenAIResponsesPayload,
  projectionsByItem: ReadonlyMap<number, readonly OpenAIResponsesBlobCandidateProjection[] | null>,
): CanonicalOpenAIResponsesPayload => {
  if (projectionsByItem.size === 0) return payload;
  const input = payload.input.flatMap((item, itemIndex): OpenAIResponsesInputItem[] => {
    const projections = projectionsByItem.get(itemIndex);
    if (projections === undefined) return [item];
    if (projections === null) return [];

    const replacement = { ...item } as OpenAIResponsesInputItem & Record<string, unknown>;
    for (const { location, projection } of projections) {
      if (location.contentIndex !== undefined) continue;
      if (projection.kind === 'preserve') replacement[location.slot] = projection.value;
      else delete replacement[location.slot];
    }

    if (item.type === 'agent_message') {
      const nested = new Map(projections.flatMap(projection =>
        projection.location.contentIndex === undefined ? [] : [[projection.location.contentIndex, projection] as const]));
      if (nested.size > 0) {
        const agentMessage = replacement as Extract<OpenAIResponsesInputItem, { type: 'agent_message' }>;
        agentMessage.content = agentMessage.content.flatMap((content, contentIndex) => {
          const projected = nested.get(contentIndex);
          if (projected === undefined) return [content];
          return projected.projection.kind === 'preserve'
            ? [{ ...content, encrypted_content: projected.projection.value }]
            : [];
        });
      }
    }

    // A carrier that carried a payload can leave the item as a bare reference
    // once it is dropped, which the target upstream cannot resolve and refuses
    // for the whole turn. See `isOnlyCarrierReference`.
    const discardedPayload = projections.some(projection =>
      projection.projection.kind === 'remove' && projection.projection.degrades);
    return isOnlyCarrierReference(replacement, discardedPayload) ? [] : [replacement];
  });
  return { ...payload, input };
};

const evaluateOpenAIResponsesCandidate = (
  payload: CanonicalOpenAIResponsesPayload,
  analysis: OpenAIResponsesRequestAnalysis,
  candidate: ModelCandidate,
) => {
  const unsatisfiedTargets: AffinityIdentity[] = [];
  const projectionsByItem = new Map<number, readonly OpenAIResponsesBlobCandidateProjection[] | null>();
  let degrades = false;

  for (const item of analysis.items) {
    if (
      item.inheritedRequiredTarget !== undefined
      && !candidateSatisfiesAffinityIdentity(candidate, item.inheritedRequiredTarget)
    ) unsatisfiedTargets.push(item.inheritedRequiredTarget);

    const projections: OpenAIResponsesBlobCandidateProjection[] = [];
    for (const blob of item.blobs) {
      const projection = blob.required
        ? projectRequiredAffinityBlob(blob.decoded, candidate)
        : projectOptionalAffinityBlob(blob.decoded, candidate);
      if (projection.kind === 'reject') {
        unsatisfiedTargets.push(projection.requiredTarget);
        continue;
      }
      if (!item.synthetic && projection.kind === 'remove') degrades ||= projection.degrades;
      projections.push({ location: blob, projection });
    }
    if (item.synthetic) {
      projectionsByItem.set(item.itemIndex, null);
      continue;
    }
    if (projections.length > 0) projectionsByItem.set(item.itemIndex, projections);
  }

  if (unsatisfiedTargets.length > 0) return { kind: 'rejected' as const };
  return {
    kind: 'accepted' as const,
    degrades,
    preferred: analysis.items.every(item => {
      if (item.inheritedRequiredTarget !== undefined) {
        const target = item.inheritedRequiredTarget;
        if (
          candidate.provider.upstreamId !== target.upstreamId
          || candidate.model.id !== target.modelId
        ) return false;
      }
      return (projectionsByItem.get(item.itemIndex) ?? []).every(projection => projection.projection.preferred);
    }),
    materialize: () => materializeOpenAIResponsesPayload(payload, projectionsByItem),
  };
};

export const analyzeOpenAIResponsesAffinity = async (
  payload: CanonicalOpenAIResponsesPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<CanonicalOpenAIResponsesPayload>> => {
  const locations = await opaqueBlobLocations(payload.input, codec);
  const analysis = analyzeOpenAIResponsesRequest(payload.input, locations);
  return defineAffinityRequest(
    analysis.requiredTargets,
    candidate => evaluateOpenAIResponsesCandidate(payload, analysis, candidate),
  );
};
