import type { AffinityCodec, DecodedAffinityBlob } from '../../shared/affinity/carrier.ts';
import { type AffinityAnalysis, type AffinityCandidate, incompatibleReasoningParts, projectOptionalAffinityBlob } from '../../shared/affinity/selection.ts';
import type { GeminiGenerateContentPart, GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini-generate-content';

interface BlobLocation {
  readonly contentIndex: number;
  readonly partIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

export interface GeminiGenerateContentAffinityAnalysis extends AffinityAnalysis {
  readonly locations: readonly BlobLocation[];
}

export const decodeGeminiGenerateContentAffinity = async (
  payload: GeminiGenerateContentRequest,
  codec: Pick<AffinityCodec, 'unwrap'>,
): Promise<GeminiGenerateContentAffinityAnalysis> => {
  const locations: BlobLocation[] = [];
  for (const [contentIndex, content] of (payload.contents ?? []).entries()) {
    if (content.role !== 'model') continue;
    for (const [partIndex, part] of (content.parts ?? []).entries()) {
      if (typeof part.thoughtSignature !== 'string' || part.thoughtSignature === '') continue;
      locations.push({ contentIndex, partIndex, decoded: await codec.unwrap(part.thoughtSignature, 'gemini-generate-content.part.thoughtSignature') });
    }
  }
  return { requiredTargets: [], locations };
};

const isReasoning = (part: GeminiGenerateContentPart): boolean =>
  part.thought === true && part.functionCall === undefined && part.functionResponse === undefined;

const projectContent = (
  candidate: AffinityCandidate, parts: readonly GeminiGenerateContentPart[], locations: readonly BlobLocation[],
) => {
  const projections = new Map(locations.map(({ partIndex, decoded }) => [partIndex, projectOptionalAffinityBlob(decoded, candidate)]));
  const dropped = incompatibleReasoningParts(parts, projections, isReasoning);
  return { projections, dropped };
};

const hasPartContent = (part: GeminiGenerateContentPart): boolean => {
  const { text, thought: _thought, thoughtSignature: _signature, ...data } = part;
  return (typeof text === 'string' && text.length > 0) || Object.keys(data).length > 0;
};

const materializeContents = (
  payload: GeminiGenerateContentRequest, projectionsByContent: ReadonlyMap<number, ReturnType<typeof projectContent>>,
): GeminiGenerateContentRequest => {
  if (payload.contents === undefined || projectionsByContent.size === 0) return payload;
  const contents = payload.contents.flatMap((content, index) => {
    const projection = projectionsByContent.get(index);
    if (projection === undefined) return [content];
    if (content.parts === undefined) throw new Error(`Gemini affinity expected parts at content index ${index}`);
    const parts = content.parts.flatMap((part, partIndex) => {
      if (projection.dropped.has(partIndex)) return [];
      const signature = projection.projections.get(partIndex);
      if (signature === undefined) return [part];
      if (signature.kind === 'preserve') return [{ ...part, thoughtSignature: signature.value }];
      const { thoughtSignature: _signature, ...replacement } = part;
      return hasPartContent(replacement) ? [replacement] : [];
    });
    return parts.length === 0 ? [] : [{ ...content, parts }];
  });
  return { ...payload, contents };
};

const planAffinity = (
  analysis: GeminiGenerateContentAffinityAnalysis, candidate: AffinityCandidate, payload: GeminiGenerateContentRequest,
) => {
  const byContent = new Map(Map.groupBy(analysis.locations, location => location.contentIndex).entries().map(([index, locations]) => {
    const parts = payload.contents?.[index]?.parts;
    if (parts === undefined) throw new Error(`Gemini affinity expected parts at content index ${index}`);
    return [index, projectContent(candidate, parts, locations)] as const;
  }));
  const contentProjections = [...byContent.values()];
  const projections = contentProjections.flatMap(content => [...content.projections.values()]);
  return {
    byContent,
    score: {
      kind: 'accepted' as const,
      degrades: contentProjections.some(content => content.dropped.size > 0)
        || projections.some(projection => projection.kind === 'remove' && projection.degrades),
      preferred: projections.every(projection => projection.preferred),
    },
  };
};

export const scoreGeminiGenerateContentAffinity = (...args: Parameters<typeof planAffinity>) => planAffinity(...args).score;

export const evaluateGeminiGenerateContentAffinity = (...[analysis, candidate, payload]: Parameters<typeof planAffinity>) => {
  const { score, byContent } = planAffinity(analysis, candidate, payload);
  return { ...score, payload: materializeContents(payload, byContent) };
};
