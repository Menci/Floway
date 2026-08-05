import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { GeminiPart, GeminiPayload } from '@floway-dev/protocols/gemini';

interface GeminiBlobLocation {
  readonly contentIndex: number;
  readonly partIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

const hasPartContent = (part: GeminiPart): boolean => {
  const { text, thought: _thought, thoughtSignature: _signature, ...data } = part;
  return (typeof text === 'string' && text.length > 0) || Object.keys(data).length > 0;
};

export const analyzeGeminiAffinity = async (
  payload: GeminiPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<GeminiPayload>> => {
  const locations: GeminiBlobLocation[] = [];
  for (const [contentIndex, content] of (payload.contents ?? []).entries()) {
    if (content.role !== 'model') continue;
    for (const [partIndex, part] of content.parts.entries()) {
      if (typeof part.thoughtSignature !== 'string') continue;
      locations.push({ contentIndex, partIndex, decoded: await codec.unwrap(part.thoughtSignature, 'gemini.part.thoughtSignature') });
    }
  }

  return defineAffinityRequest([], candidate => {
    const projections = locations.map(location => ({ location, projection: projectOptionalAffinityBlob(location.decoded, candidate) }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      materialize: () => {
        const candidatePayload = structuredClone(payload);
        if (candidatePayload.contents === undefined) return candidatePayload;
        const byContent = Map.groupBy(projections, item => item.location.contentIndex);
        const emptiedByAffinity = new Set<number>();
        for (const [contentIndex, contentProjections] of byContent) {
          const content = candidatePayload.contents[contentIndex];
          const replacements = new Map<number, GeminiPart | null>();
          for (const { location, projection } of contentProjections) {
            const part = content.parts[location.partIndex];
            if (location.decoded.kind === 'foreign') continue;
            if (projection.kind === 'preserve') {
              replacements.set(location.partIndex, { ...part, thoughtSignature: projection.value });
            } else {
              const replacement = { ...part };
              delete replacement.thoughtSignature;
              replacements.set(location.partIndex, hasPartContent(replacement) ? replacement : null);
            }
          }
          content.parts = content.parts.flatMap((part, partIndex) => {
            const replacement = replacements.get(partIndex);
            return replacement === undefined ? [part] : replacement === null ? [] : [replacement];
          });
          if (content.parts.length === 0) emptiedByAffinity.add(contentIndex);
        }
        candidatePayload.contents = candidatePayload.contents.filter((_content, contentIndex) => !emptiedByAffinity.has(contentIndex));
        return candidatePayload;
      },
    };
  });
};
