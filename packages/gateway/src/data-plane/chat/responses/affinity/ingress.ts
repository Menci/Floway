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
  projectNativeResponsesUpstreamAffinityBlob,
} from '../../shared/affinity/index.ts';
import { replaceResponsesOpaqueLocations, responsesOpaqueLocations, type ResponsesOpaqueLocation } from './opaque-locations.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';

interface ResponsesBlobLocation extends ResponsesOpaqueLocation {
  readonly itemIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

interface ResponsesBlobAnalysis extends ResponsesBlobLocation {
  readonly requirement: 'target' | 'upstream' | null;
}

interface ResponsesItemAnalysis {
  readonly itemIndex: number;
  readonly synthetic: boolean;
  readonly blobs: readonly ResponsesBlobAnalysis[];
  readonly inheritedRequiredTarget?: AffinityTarget;
}

interface ResponsesRequestAnalysis {
  readonly requiredTargets: readonly AffinityTarget[];
  readonly requiredNativeResponsesUpstreamIds: readonly string[];
  readonly items: readonly ResponsesItemAnalysis[];
}

interface ResponsesBlobCandidateProjection {
  readonly location: ResponsesBlobLocation;
  readonly projection: OptionalAffinityBlobProjection;
}

const itemInheritsRequiredTarget = (item: ResponsesInputItem): boolean =>
  ['compaction', 'compaction_summary', 'program', 'program_output'].includes(item.type);

const blobRequirement = (item: ResponsesInputItem, location: ResponsesBlobLocation): 'target' | 'upstream' | null => {
  if (location.required && location.decoded.kind === 'owned' && location.decoded.value !== undefined) return 'upstream';
  return (item.type === 'context_compaction'
    ? location.decoded.kind === 'owned' && location.decoded.value !== undefined
    : itemInheritsRequiredTarget(item))
    ? 'target'
    : null;
};

const opaqueBlobLocations = async (
  items: readonly ResponsesInputItem[],
  codec: AffinityCodec,
): Promise<ResponsesBlobLocation[]> => {
  const locations: ResponsesBlobLocation[] = [];
  for (const [itemIndex, item] of items.entries()) {
    for (const location of responsesOpaqueLocations(item)) {
      let decoded = await codec.unwrap(location.value, location.domain);
      for (const legacyDomain of location.legacyDomains ?? []) {
        if (decoded.kind === 'owned') break;
        decoded = await codec.unwrap(location.value, legacyDomain);
      }
      locations.push({
        ...location,
        itemIndex,
        decoded,
      });
    }
  }
  return locations;
};

const analyzeResponsesRequest = (
  items: readonly ResponsesInputItem[],
  locations: readonly ResponsesBlobLocation[],
): ResponsesRequestAnalysis => {
  const locationsByItem = Map.groupBy(locations, location => location.itemIndex);
  const requiredTargets: AffinityTarget[] = [];
  const requiredNativeResponsesUpstreamIds: string[] = [];
  const itemAnalyses: ResponsesItemAnalysis[] = [];
  let latestOwnedTarget: AffinityTarget | undefined;

  for (const [itemIndex, item] of items.entries()) {
    const itemLocations = locationsByItem.get(itemIndex) ?? [];
    const blobs = itemLocations.map(location => {
      const requirement = blobRequirement(item, location);
      if (location.decoded.kind === 'owned') {
        latestOwnedTarget = location.decoded.affinity;
        if (requirement === 'target') requiredTargets.push(latestOwnedTarget);
        if (requirement === 'upstream') requiredNativeResponsesUpstreamIds.push(latestOwnedTarget.upstreamId);
      }
      return { ...location, requirement };
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

  return { requiredTargets, requiredNativeResponsesUpstreamIds, items: itemAnalyses };
};

const materializeResponsesPayload = (
  payload: CanonicalResponsesPayload,
  projectionsByItem: ReadonlyMap<number, readonly ResponsesBlobCandidateProjection[] | null>,
): CanonicalResponsesPayload => {
  const candidatePayload = structuredClone(payload);
  candidatePayload.input = candidatePayload.input.flatMap((item, itemIndex): ResponsesInputItem[] => {
    const projections = projectionsByItem.get(itemIndex);
    if (projections === undefined) return [item];
    if (projections === null) return [];

    const replacements = new Map<string, string | undefined>();
    for (const { location, projection } of projections) {
      replacements.set(location.key, projection.kind === 'preserve' ? projection.value : undefined);
    }
    return [replaceResponsesOpaqueLocations(item, replacements)];
  });
  return candidatePayload;
};

const evaluateResponsesCandidate = (
  payload: CanonicalResponsesPayload,
  analysis: ResponsesRequestAnalysis,
  candidate: ModelCandidate,
) => {
  const unsatisfiedTargets: AffinityTarget[] = [];
  const projectionsByItem = new Map<number, readonly ResponsesBlobCandidateProjection[] | null>();
  let degrades = false;

  for (const item of analysis.items) {
    if (
      item.inheritedRequiredTarget !== undefined
      && !candidateSatisfiesAffinityTarget(candidate, item.inheritedRequiredTarget)
    ) unsatisfiedTargets.push(item.inheritedRequiredTarget);

    const projections: ResponsesBlobCandidateProjection[] = [];
    for (const blob of item.blobs) {
      const projection = blob.requirement === 'target'
        ? projectRequiredAffinityBlob(blob.decoded, candidate)
        : blob.requirement === 'upstream'
          ? projectNativeResponsesUpstreamAffinityBlob(blob.decoded, candidate)
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
    projectionsByItem.set(item.itemIndex, projections);
  }

  if (unsatisfiedTargets.length > 0) return { kind: 'rejected' as const };
  return {
    kind: 'accepted' as const,
    degrades,
    materialize: () => materializeResponsesPayload(payload, projectionsByItem),
  };
};

export const analyzeResponsesAffinity = async (
  payload: CanonicalResponsesPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<CanonicalResponsesPayload>> => {
  const locations = await opaqueBlobLocations(payload.input, codec);
  const analysis = analyzeResponsesRequest(payload.input, locations);
  return defineAffinityRequest(
    analysis.requiredTargets,
    candidate => evaluateResponsesCandidate(payload, analysis, candidate),
    analysis.requiredNativeResponsesUpstreamIds,
  );
};
