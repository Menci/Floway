import {
  type AffinityCodec,
  type AffinityRequestAnalysis,
  type AffinityTarget,
  candidateSatisfiesAffinityTarget,
  type DecodedAffinityBlob,
  defineAffinityRequest,
  type OptionalAffinityBlobProjection,
  projectOptionalAffinityBlob,
  projectRequiredAffinityBlob,
} from '../../shared/affinity/index.ts';
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
  readonly inheritedRequiredTarget?: AffinityTarget;
}

interface OpenAIResponsesRequestAnalysis {
  readonly requiredTargets: readonly AffinityTarget[];
  readonly items: readonly OpenAIResponsesItemAnalysis[];
}

interface OpenAIResponsesBlobCandidateProjection {
  readonly location: OpenAIResponsesBlobLocation;
  readonly projection: OptionalAffinityBlobProjection;
}

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalItemType(itemType)}.${slot}`;

const itemInheritsRequiredTarget = (item: OpenAIResponsesInputItem): boolean =>
  ['compaction', 'compaction_summary', 'program', 'program_output'].includes(item.type);

const blobRequiresOriginalTarget = (item: OpenAIResponsesInputItem, decoded: DecodedAffinityBlob): boolean =>
  item.type === 'context_compaction'
    ? decoded.kind === 'owned' && decoded.value !== undefined
    : itemInheritsRequiredTarget(item);

const opaqueBlobLocations = async (
  items: readonly OpenAIResponsesInputItem[],
  codec: AffinityCodec,
): Promise<OpenAIResponsesBlobLocation[]> => {
  const locations: OpenAIResponsesBlobLocation[] = [];
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

const analyzeOpenAIResponsesRequest = (
  items: readonly OpenAIResponsesInputItem[],
  locations: readonly OpenAIResponsesBlobLocation[],
): OpenAIResponsesRequestAnalysis => {
  const locationsByItem = Map.groupBy(locations, location => location.itemIndex);
  const requiredTargets: AffinityTarget[] = [];
  const itemAnalyses: OpenAIResponsesItemAnalysis[] = [];
  let latestOwnedTarget: AffinityTarget | undefined;

  for (const [itemIndex, item] of items.entries()) {
    const itemLocations = locationsByItem.get(itemIndex) ?? [];
    const blobs = itemLocations.map(location => {
      const required = blobRequiresOriginalTarget(item, location.decoded);
      if (location.decoded.kind === 'owned') {
        latestOwnedTarget = location.decoded.affinity;
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

    return [replacement];
  });
  return { ...payload, input };
};

const evaluateOpenAIResponsesCandidate = (
  payload: CanonicalOpenAIResponsesPayload,
  analysis: OpenAIResponsesRequestAnalysis,
  candidate: ModelCandidate,
) => {
  const unsatisfiedTargets: AffinityTarget[] = [];
  const projectionsByItem = new Map<number, readonly OpenAIResponsesBlobCandidateProjection[] | null>();
  let degrades = false;

  for (const item of analysis.items) {
    if (
      item.inheritedRequiredTarget !== undefined
      && !candidateSatisfiesAffinityTarget(candidate, item.inheritedRequiredTarget)
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
