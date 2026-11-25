import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, incompatibleReasoningParts, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { GeminiGenerateContentPart, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

interface GeminiGenerateContentBlobLocation {
  readonly contentIndex: number;
  readonly partIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

const hasPartContent = (part: GeminiGenerateContentPart): boolean => {
  const { text, thought: _thought, thoughtSignature: _signature, ...data } = part;
  return (typeof text === 'string' && text.length > 0) || Object.keys(data).length > 0;
};

export const analyzeGeminiGenerateContentAffinity = async (
  payload: GeminiGenerateContentPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<GeminiGenerateContentPayload>> => {
  const locations: GeminiGenerateContentBlobLocation[] = [];
  for (const [contentIndex, content] of (payload.contents ?? []).entries()) {
    if (content.role !== 'model') continue;
    for (const [partIndex, part] of (content.parts ?? []).entries()) {
      if (typeof part.thoughtSignature !== 'string' || part.thoughtSignature === '') continue;
      locations.push({ contentIndex, partIndex, decoded: await codec.unwrap(part.thoughtSignature, 'gemini-generate-content.part.thoughtSignature') });
    }
  }

  const locationsByContent = Map.groupBy(locations, location => location.contentIndex);
  return defineAffinityRequest([], candidate => {
    const contents = [...locationsByContent].map(([contentIndex, contentLocations]) => {
      const projections = new Map(contentLocations.map(({ partIndex, decoded }) => [partIndex, projectOptionalAffinityBlob(decoded, candidate)]));
      const dropped = incompatibleReasoningParts(payload.contents![contentIndex].parts!, projections,
        part => part.thought === true && part.functionCall === undefined && part.functionResponse === undefined);
      return { contentIndex, projections, dropped };
    });
    const projections = contents.flatMap(content => [...content.projections.values()]);
    return {
      kind: 'accepted',
      degrades: contents.some(content => content.dropped.size > 0) || projections.some(projection => projection.kind === 'remove' && projection.degrades),
      preferred: projections.every(projection => projection.preferred),
      materialize: () => {
        if (payload.contents === undefined || contents.length === 0) return payload;
        const byIndex = new Map(contents.map(projection => [projection.contentIndex, projection]));
        return {
          ...payload, contents: payload.contents.flatMap((content, index) => {
            const projected = byIndex.get(index);
            if (projected === undefined) return [content];
            if (content.parts === undefined) throw new Error('Gemini generateContent affinity expected content parts');
            const { projections, dropped } = projected;
            const parts = content.parts.flatMap((part, partIndex) => {
              if (dropped.has(partIndex)) return [];
              const projection = projections.get(partIndex);
              if (projection === undefined) return [part];
              if (projection.kind === 'preserve') return [{ ...part, thoughtSignature: projection.value }];
              const { thoughtSignature: _signature, ...replacement } = part;
              return hasPartContent(replacement) ? [replacement] : [];
            });
            return parts.length === 0 ? [] : [{ ...content, parts }];
          }),
        };
      },
    };
  });
};
