import type { AffinityCodec } from './codec.ts';
import { blobForCandidate, ownedAffinities, type PreparedAffinityPayload } from './prepared.ts';
import type { DecodedAffinityBlob } from './types.ts';
import type { GeminiPart, GeminiPayload } from '@floway-dev/protocols/gemini';

interface GeminiBlobLocation {
  readonly contentIndex: number;
  readonly partIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

export const prepareGeminiAffinity = async (
  payload: GeminiPayload,
  codec: AffinityCodec,
): Promise<PreparedAffinityPayload<GeminiPayload>> => {
  const locations: GeminiBlobLocation[] = [];
  for (const [contentIndex, content] of (payload.contents ?? []).entries()) {
    if (content.role !== 'model') continue;
    for (const [partIndex, part] of content.parts.entries()) {
      if (typeof part.thoughtSignature !== 'string') continue;
      locations.push({ contentIndex, partIndex, decoded: await codec.unwrap(part.thoughtSignature) });
    }
  }

  return {
    affinities: ownedAffinities(locations.map(location => location.decoded)),
    payloadForCandidate: candidate => {
      const candidatePayload = structuredClone(payload);
      if (candidatePayload.contents === undefined) return candidatePayload;
      const byContent = Map.groupBy(locations, location => location.contentIndex);
      for (const [contentIndex, contentLocations] of byContent) {
        const content = candidatePayload.contents[contentIndex];
        const replacements = new Map<number, GeminiPart | null>();
        for (const location of contentLocations) {
          const part = content.parts[location.partIndex];
          const selected = blobForCandidate(location.decoded, candidate);
          if (selected.present) replacements.set(location.partIndex, { ...part, thoughtSignature: selected.value });
          else if (location.decoded.kind === 'owned' && location.decoded.value === undefined) replacements.set(location.partIndex, null);
          else {
            const replacement = { ...part };
            delete replacement.thoughtSignature;
            replacements.set(location.partIndex, replacement);
          }
        }
        content.parts = content.parts.flatMap((part, partIndex) => {
          const replacement = replacements.get(partIndex);
          return replacement === undefined ? [part] : replacement === null ? [] : [replacement];
        });
      }
      return candidatePayload;
    },
  };
};
