import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const wrapGeminiGenerateContentAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const anchored = new Set<number>();
  for await (const frame of frames) {
    if (frame.type !== 'event' || 'error' in frame.event || frame.event.candidates === undefined) { yield frame; continue; }
    const event = frame.event;
    const candidates = await Promise.all(event.candidates!.map(async candidate => {
      const index = candidate.index ?? 0;
      const original = candidate.content?.parts ?? [];
      const parts = await Promise.all(original.map(async part => {
        if (part.thoughtSignature === undefined) return part;
        const thoughtSignature = await options.codec.wrap(part.thoughtSignature, options.affinity, 'gemini-generate-content.part.thoughtSignature');
        anchored.add(index);
        return { ...part, thoughtSignature };
      }));
      if (candidate.finishReason !== undefined && !anchored.has(index)) {
        parts.push({ thoughtSignature: await options.codec.wrap(undefined, options.affinity, 'gemini-generate-content.part.thoughtSignature') });
        anchored.add(index);
      }
      return parts.length === original.length && parts.every((part, partIndex) => part === original[partIndex])
        ? candidate
        : { ...candidate, content: { ...candidate.content, role: 'model' as const, parts } };
    }));
    yield candidates.every((candidate, index) => candidate === event.candidates![index]) ? frame : eventFrame({ ...event, candidates });
  }
};
