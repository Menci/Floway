import { GEMINI_AFFINITY_DOMAIN } from './domain.ts';
import type { AffinityCodec } from '../../shared/affinity/codec.ts';
import { blobForCandidate, ownedAffinityEvidence, type PreparedAffinityPayload } from '../../shared/affinity/prepared.ts';
import type { DecodedAffinityBlob } from '../../shared/affinity/types.ts';
import type { GeminiContent, GeminiPart, GeminiPayload } from '@floway-dev/protocols/gemini';

interface GeminiBlobLocation {
  readonly contentIndex: number;
  readonly partIndex: number;
  readonly decoded: DecodedAffinityBlob;
}

const visiblePart = (part: GeminiPart): boolean => {
  const { thoughtSignature: _signature, ...data } = part;
  return Object.keys(data).length > 0;
};

const findPreviousVisiblePart = (
  contents: GeminiContent[],
  contentIndex: number,
  partIndex: number,
  fromEnd: number,
): GeminiPart => {
  let remaining = fromEnd;
  for (let currentContent = contentIndex; currentContent >= 0; currentContent -= 1) {
    const content = contents[currentContent];
    if (content.role !== 'model') break;
    const start = currentContent === contentIndex ? partIndex - 1 : content.parts.length - 1;
    for (let currentPart = start; currentPart >= 0; currentPart -= 1) {
      const part = content.parts[currentPart];
      if (!visiblePart(part)) continue;
      remaining -= 1;
      if (remaining === 0) return part;
    }
  }
  throw new Error(`Gemini affinity carrier could not find previous visible part at offset ${fromEnd}`);
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
      locations.push({ contentIndex, partIndex, decoded: await codec.unwrap(part.thoughtSignature, GEMINI_AFFINITY_DOMAIN) });
    }
  }

  return {
    routingEvidence: ownedAffinityEvidence(locations.map(location => location.decoded)),
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
          const selected = blobForCandidate(location.decoded, candidate);
          if (location.decoded.kind === 'foreign') {
            replacements.set(location.partIndex, part);
            continue;
          }
          const affinity = location.decoded.envelope.affinity;
          if (affinity.syntheticItem === true) {
            replacements.set(location.partIndex, null);
          } else if (selected.present && affinity.geminiPartFromEnd !== undefined) {
            const target = findPreviousVisiblePart(
              candidatePayload.contents,
              location.contentIndex,
              location.partIndex,
              affinity.geminiPartFromEnd,
            );
            target.thoughtSignature = selected.value;
            replacements.set(location.partIndex, null);
          } else if (selected.present) {
            replacements.set(location.partIndex, { ...part, thoughtSignature: selected.value });
          } else {
            const replacement = { ...part };
            delete replacement.thoughtSignature;
            replacements.set(location.partIndex, visiblePart(replacement) ? replacement : null);
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
