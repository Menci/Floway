import type { AffinityEgressOptions } from './affinity-egress.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiPart, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

interface CandidateState {
  sawCarrier: boolean;
  finished: boolean;
}

interface DeferredCandidate {
  readonly candidate: GeminiCandidate;
  readonly carrierValues: string[];
  readonly state: CandidateState;
}

const withoutThoughtSignature = (part: GeminiPart): GeminiPart => {
  const { thoughtSignature: _signature, ...visible } = part;
  return visible;
};

const hasPartData = (part: GeminiPart): boolean => Object.keys(part).length > 0;

const eventWithoutUsage = (event: GeminiStreamEvent): GeminiStreamEvent => {
  if ('error' in event || event.usageMetadata === undefined) return event;
  const { usageMetadata: _usage, ...rest } = event;
  return rest;
};

export const wrapGeminiAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const states = new Map<number, CandidateState>();

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    if ('error' in frame.event) {
      yield frame;
      return;
    }

    const visibleCandidates: GeminiCandidate[] = [];
    const deferredCandidates: DeferredCandidate[] = [];

    for (const candidate of frame.event.candidates ?? []) {
      const state = states.get(candidate.index) ?? { sawCarrier: false, finished: false };
      if (state.finished) throw new Error(`Gemini candidate ${candidate.index} emitted data after its finishReason`);
      states.set(candidate.index, state);

      const carrierValues: string[] = [];
      const visibleParts: GeminiPart[] = [];
      for (const part of candidate.content.parts) {
        if (typeof part.thoughtSignature === 'string') carrierValues.push(part.thoughtSignature);
        const visible = withoutThoughtSignature(part);
        if (hasPartData(visible)) visibleParts.push(visible);
      }

      const needsSynthetic = candidate.finishReason !== undefined && !state.sawCarrier && carrierValues.length === 0;
      if (carrierValues.length > 0 || needsSynthetic) {
        deferredCandidates.push({ candidate, carrierValues, state });
        if (visibleParts.length > 0) {
          const { finishReason: _finishReason, ...rest } = candidate;
          visibleCandidates.push({ ...rest, content: { ...candidate.content, parts: visibleParts } });
        }
        continue;
      }

      visibleCandidates.push(candidate);
      if (candidate.finishReason !== undefined) state.finished = true;
    }

    if (visibleCandidates.length > 0 || (frame.event.candidates?.length ?? 0) === 0) {
      const visibleEvent = deferredCandidates.length > 0 ? eventWithoutUsage(frame.event) : frame.event;
      yield eventFrame({ ...visibleEvent, candidates: visibleCandidates });
    }

    if (deferredCandidates.length === 0) continue;

    const wrappedCandidates = await Promise.all(deferredCandidates.map(async ({ candidate, carrierValues, state }) => {
      const values = carrierValues.length > 0 ? carrierValues : [undefined];
      const parts = await Promise.all(values.map(async value => ({
        thoughtSignature: await options.codec.wrap(value, options.affinity),
      })));
      state.sawCarrier = true;
      if (candidate.finishReason !== undefined) state.finished = true;
      return {
        index: candidate.index,
        content: {
          ...(candidate.content.role !== undefined ? { role: candidate.content.role } : {}),
          parts,
        },
        ...(candidate.finishReason !== undefined ? { finishReason: candidate.finishReason } : {}),
      } satisfies GeminiCandidate;
    }));
    yield eventFrame({ ...frame.event, candidates: wrappedCandidates });
  }
};
