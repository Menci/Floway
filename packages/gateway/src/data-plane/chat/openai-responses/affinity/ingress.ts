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
import type { OpenAIChatCompletionsPrivateCodec } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';

interface OpenAIResponsesBlobLocation {
  readonly itemIndex: number;
  readonly slot: string;
  readonly contentIndex?: number;
  readonly decoded: DecodedAffinityBlob;
  readonly assistantBoundary?: string;
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
  itemType === 'compaction' || itemType === 'compaction_summary' || itemType === 'context_compaction' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `openai-responses.${canonicalItemType(itemType)}.${slot}`;

const itemInheritsRequiredTarget = (item: CanonicalOpenAIResponsesInputItem): boolean =>
  !isOpenAIResponsesCompactShimItem(item)
  && ['compaction', 'compaction_summary', 'context_compaction', 'program', 'program_output'].includes(item.type);

const blobRequiresOriginalTarget = (item: CanonicalOpenAIResponsesInputItem, decoded: DecodedAffinityBlob): boolean =>
  item.type === 'compaction' || item.type === 'compaction_summary' || item.type === 'context_compaction'
    ? decoded.kind === 'owned' && decoded.value !== undefined
    : itemInheritsRequiredTarget(item);

const opaqueBlobLocations = async (
  items: readonly CanonicalOpenAIResponsesInputItem[],
  codec: AffinityCodec,
  privateCodec?: OpenAIChatCompletionsPrivateCodec,
): Promise<OpenAIResponsesBlobLocation[]> => {
  const locations: OpenAIResponsesBlobLocation[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const topLevel = (item as { encrypted_content?: unknown }).encrypted_content;
    if (typeof topLevel === 'string' && !isOpenAIResponsesCompactShimItem(item)) {
      const decoded = await codec.unwrap(topLevel, carrierDomain(item.type, 'encrypted_content'));
      const ownedAssistant = item.type === 'reasoning' && decoded.kind === 'owned' && privateCodec !== undefined
        ? await privateCodec.unencapsulate(decoded.value)
        : undefined;
      const assistantBoundary = ownedAssistant !== undefined
        ? await privateCodec!.encapsulate({ sidecar: { upstreamProtocol: 'openaiChatCompletions' } })
        : undefined;
      locations.push({ itemIndex, slot: 'encrypted_content', decoded, ...(assistantBoundary !== undefined ? { assistantBoundary } : {}) });
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
  items: readonly CanonicalOpenAIResponsesInputItem[],
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
  const input = payload.input.flatMap((item, itemIndex): CanonicalOpenAIResponsesInputItem[] => {
    const projections = projectionsByItem.get(itemIndex);
    if (projections === undefined) return [item];
    if (projections === null) return [];

    const replacement = { ...item } as CanonicalOpenAIResponsesInputItem & Record<string, unknown>;
    for (const { location, projection } of projections) {
      if (location.contentIndex !== undefined) continue;
      if (projection.kind === 'preserve') replacement[location.slot] = projection.value;
      else delete replacement[location.slot];
    }

    if (item.type === 'agent_message') {
      const nested = new Map(projections.flatMap(projection =>
        projection.location.contentIndex === undefined ? [] : [[projection.location.contentIndex, projection] as const]));
      if (nested.size > 0) {
        const agentMessage = replacement as Extract<CanonicalOpenAIResponsesInputItem, { type: 'agent_message' }>;
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
      // Discard incompatible provider replay state while retaining the authenticated assistant interval boundary.
      projections.push({
        location: blob, projection: projection.kind === 'remove' && blob.assistantBoundary !== undefined
          ? { kind: 'preserve', value: blob.assistantBoundary, preferred: projection.preferred }
          : projection,
      });
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
  privateCodec?: OpenAIChatCompletionsPrivateCodec,
): Promise<AffinityRequestAnalysis<CanonicalOpenAIResponsesPayload>> => {
  const locations = await opaqueBlobLocations(payload.input, codec, privateCodec);
  const analysis = analyzeOpenAIResponsesRequest(payload.input, locations);
  return defineAffinityRequest(
    analysis.requiredTargets,
    candidate => evaluateOpenAIResponsesCandidate(payload, analysis, candidate),
  );
};
