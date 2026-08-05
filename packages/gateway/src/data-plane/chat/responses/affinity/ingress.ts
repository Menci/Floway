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
import { replaceResponsesOpaqueLocations, responsesOpaqueLocations, type ResponsesOpaqueLocation } from './opaque-locations.ts';
import type { CanonicalResponsesPayload, ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';

interface ResponsesBlobLocation extends ResponsesOpaqueLocation {
  readonly itemIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

interface ResponsesBlobAnalysis extends ResponsesBlobLocation {
  readonly required: boolean;
}

interface ResponsesItemAnalysis {
  readonly itemIndex: number;
  readonly synthetic: boolean;
  readonly blobs: readonly ResponsesBlobAnalysis[];
  readonly inheritedRequiredTarget?: AffinityTarget;
}

interface ResponsesRequestAnalysis {
  readonly requiredTargets: readonly AffinityTarget[];
  readonly items: readonly ResponsesItemAnalysis[];
}

interface ResponsesBlobCandidateProjection {
  readonly location: ResponsesBlobLocation;
  readonly projection: OptionalAffinityBlobProjection;
}

const itemInheritsRequiredTarget = (item: ResponsesInputItem): boolean =>
  ['compaction', 'compaction_summary', 'program', 'program_output'].includes(item.type);

const blobRequiresOriginalTarget = (item: ResponsesInputItem, location: ResponsesBlobLocation): boolean =>
  (location.required && location.decoded.kind === 'owned' && location.decoded.value !== undefined)
  || (item.type === 'context_compaction'
    ? location.decoded.kind === 'owned' && location.decoded.value !== undefined
    : itemInheritsRequiredTarget(item));

const opaqueBlobLocations = async (
  items: readonly ResponsesInputItem[],
  codec: AffinityCodec,
): Promise<ResponsesBlobLocation[]> => {
  const locations: ResponsesBlobLocation[] = [];
  for (const [itemIndex, item] of items.entries()) {
    for (const location of responsesOpaqueLocations(item)) {
      locations.push({
        ...location,
        itemIndex,
        decoded: await codec.unwrap(location.value, location.domain),
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
  const itemAnalyses: ResponsesItemAnalysis[] = [];
  let latestOwnedTarget: AffinityTarget | undefined;

  for (const [itemIndex, item] of items.entries()) {
    const itemLocations = locationsByItem.get(itemIndex) ?? [];
    const blobs = itemLocations.map(location => {
      const required = blobRequiresOriginalTarget(item, location);
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
  );
};
