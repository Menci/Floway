import { type AffinityCodec, blobForExactCandidate, preferredAffinityEvidence, type DecodedAffinityBlob, type PreparedAffinityPayload } from '../../shared/affinity/index.ts';
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

export const prepareGeminiAffinity = async (
  payload: GeminiPayload,
  codec: AffinityCodec,
): Promise<PreparedAffinityPayload<GeminiPayload>> => {
  const locations: GeminiBlobLocation[] = [];
  for (const [contentIndex, content] of (payload.contents ?? []).entries()) {
    if (content.role !== 'model') continue;
    for (const [partIndex, part] of content.parts.entries()) {
      if (typeof part.thoughtSignature !== 'string') continue;
      locations.push({ contentIndex, partIndex, decoded: await codec.unwrap(part.thoughtSignature, 'gemini.part.thoughtSignature') });
    }
  }

  return {
    routingEvidence: preferredAffinityEvidence(locations.map(location => location.decoded)),
    payloadForCandidate: candidate => {
      const candidatePayload = structuredClone(payload);
      if (candidatePayload.contents === undefined) return candidatePayload;
      const byContent = Map.groupBy(locations, location => location.contentIndex);
      const emptiedByAffinity = new Set<number>();
      for (const [contentIndex, contentLocations] of byContent) {
        const content = candidatePayload.contents[contentIndex];
        const replacements = new Map<number, GeminiPart | null>();
        for (const location of contentLocations) {
          const part = content.parts[location.partIndex];
          const selected = blobForExactCandidate(location.decoded, candidate);
          if (location.decoded.kind === 'foreign') continue;
          if (selected.present) {
            replacements.set(location.partIndex, { ...part, thoughtSignature: selected.value });
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
};
