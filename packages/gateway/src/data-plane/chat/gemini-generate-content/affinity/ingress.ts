import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import { withIndexesChanged, withKeysChanged } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentContent, GeminiGenerateContentPart, GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';

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
    for (const [partIndex, part] of content.parts.entries()) {
      if (typeof part.thoughtSignature !== 'string') continue;
      locations.push({ contentIndex, partIndex, decoded: await codec.unwrap(part.thoughtSignature, 'gemini-generate-content.part.thoughtSignature') });
    }
  }

  return defineAffinityRequest([], candidate => {
    const projections = locations.map(location => ({ location, projection: projectOptionalAffinityBlob(location.decoded, candidate) }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      // Rebuilt rather than cloned: the payload is the record's, so it is frozen, and a content
      // no projection touches rides through by identity. What one candidate is owed differs from
      // what the next is by a handful of objects, not by a copy of the conversation.
      materialize: () => {
        const contents = payload.contents;
        if (contents === undefined) return payload;
        const byContent = Map.groupBy(projections, item => item.location.contentIndex);
        const emptiedByAffinity = new Set<number>();
        const rewritten = new Map<number, GeminiGenerateContentContent>();
        for (const [contentIndex, contentProjections] of byContent) {
          const content = contents[contentIndex];
          const replacements = new Map<number, GeminiGenerateContentPart | null>();
          for (const { location, projection } of contentProjections) {
            const part = content.parts[location.partIndex];
            if (location.decoded.kind === 'foreign') continue;
            if (projection.kind === 'preserve') {
              replacements.set(location.partIndex, { ...part, thoughtSignature: projection.value });
            } else {
              const replacement = withKeysChanged(part, { thoughtSignature: undefined });
              replacements.set(location.partIndex, hasPartContent(replacement) ? replacement : null);
            }
          }
          const parts = withIndexesChanged(content.parts, replacements);
          if (parts.length === 0) emptiedByAffinity.add(contentIndex);
          rewritten.set(contentIndex, withKeysChanged(content, { parts }));
        }
        return withKeysChanged(payload, {
          contents: contents
            .map((content, contentIndex) => rewritten.get(contentIndex) ?? content)
            .filter((_content, contentIndex) => !emptiedByAffinity.has(contentIndex)),
        });
      },
    };
  });
};
