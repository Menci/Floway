import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

export const wrapGeminiGenerateContentAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;
    if ('error' in event) {
      yield frame;
      return;
    }
    if (event.candidates === undefined) {
      yield frame;
      continue;
    }
    const candidates = await Promise.all(event.candidates.map(async candidate => {
      if (candidate.content?.parts === undefined) return candidate;
      const content = candidate.content;
      const parts = await Promise.all(content.parts!.map(async part => {
        if (part.thoughtSignature === undefined || part.thoughtSignature === '') return part;
        return {
          ...part,
          thoughtSignature: await options.codec.wrap(part.thoughtSignature, options.affinity, 'gemini-generate-content.part.thoughtSignature'),
        };
      }));
      return parts.every((part, index) => part === content.parts![index]) ? candidate : { ...candidate, content: { ...content, parts } };
    }));
    yield candidates.every((candidate, index) => candidate === event.candidates![index]) ? frame : eventFrame({ ...event, candidates });
  }
};
