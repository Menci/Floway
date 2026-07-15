import type { AffinityEgressOptions } from './affinity-egress.ts';
import { GEMINI_AFFINITY_DOMAIN } from './carrier-domains.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiPart, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

interface CandidateState {
  sawCarrier: boolean;
  finished: boolean;
}

interface CandidatePlan {
  readonly candidate: GeminiCandidate;
  readonly carriers: Array<{ readonly value: string; readonly visiblePartIndex?: number }>;
  readonly visibleParts: GeminiPart[];
  readonly needsSynthetic: boolean;
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

    const plans: CandidatePlan[] = [];

    for (const candidate of frame.event.candidates ?? []) {
      const state = states.get(candidate.index) ?? { sawCarrier: false, finished: false };
      if (state.finished) throw new Error(`Gemini candidate ${candidate.index} emitted data after its finishReason`);
      states.set(candidate.index, state);

      const carriers: Array<{ value: string; visiblePartIndex?: number }> = [];
      const visibleParts: GeminiPart[] = [];
      for (const part of candidate.content.parts) {
        const visible = withoutThoughtSignature(part);
        const hasVisible = hasPartData(visible);
        if (typeof part.thoughtSignature === 'string') {
          carriers.push({
            value: part.thoughtSignature,
            ...(hasVisible ? { visiblePartIndex: visibleParts.length } : {}),
          });
        }
        if (hasVisible) visibleParts.push(visible);
      }

      const needsSynthetic = candidate.finishReason !== undefined && !state.sawCarrier && carriers.length === 0;
      plans.push({ candidate, carriers, visibleParts, needsSynthetic, state });
    }

    const needsDeferredCarrier = plans.some(plan => plan.carriers.length > 0 || plan.needsSynthetic);
    if (!needsDeferredCarrier) {
      for (const plan of plans) {
        if (plan.candidate.finishReason !== undefined) plan.state.finished = true;
      }
      yield frame;
      continue;
    }

    const visibleCandidates = plans.flatMap(plan => {
      const parts = plan.carriers.length > 0 ? plan.visibleParts : plan.candidate.content.parts;
      if (parts.length === 0) return [];
      const { finishReason: _finishReason, ...rest } = plan.candidate;
      return [{ ...rest, content: { ...plan.candidate.content, parts } }];
    });
    if (visibleCandidates.length > 0 || (frame.event.candidates?.length ?? 0) === 0) {
      yield eventFrame({ ...eventWithoutUsage(frame.event), candidates: visibleCandidates });
    }

    const wrappedCandidates = await Promise.all(plans.flatMap(plan => {
      const hasCarrier = plan.carriers.length > 0 || plan.needsSynthetic;
      if (!hasCarrier && plan.candidate.finishReason === undefined) return [];
      return [plan];
    }).map(async ({ candidate, carriers, visibleParts, needsSynthetic, state }) => {
      const planned = carriers.length > 0
        ? carriers.map(carrier => ({
            value: carrier.value as string | undefined,
            ...(carrier.visiblePartIndex !== undefined
              ? { partFromEnd: visibleParts.length - carrier.visiblePartIndex }
              : {}),
          }))
        : needsSynthetic
          ? [{ value: undefined, synthetic: true }]
          : [];
      const parts = await Promise.all(planned.map(async carrier => ({
        thoughtSignature: await options.codec.wrap(
          carrier.value,
          {
            ...options.affinity,
            ...('synthetic' in carrier ? { syntheticItem: true } : {}),
            ...('partFromEnd' in carrier ? { geminiPartFromEnd: carrier.partFromEnd } : {}),
          },
          GEMINI_AFFINITY_DOMAIN,
        ),
      })));
      if (parts.length > 0) state.sawCarrier = true;
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
