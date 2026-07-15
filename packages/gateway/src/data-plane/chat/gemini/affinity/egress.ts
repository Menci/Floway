import { GEMINI_AFFINITY_DOMAIN } from './domain.ts';
import type { AffinityEgressOptions } from '../../shared/affinity/egress-options.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiPart, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

interface CandidateState {
  anchored: boolean;
  finished: boolean;
}

const withoutThoughtSignature = (part: GeminiPart): GeminiPart => {
  const { thoughtSignature: _signature, ...visible } = part;
  return visible;
};

const hasPartData = (part: GeminiPart): boolean => Object.keys(withoutThoughtSignature(part)).length > 0;

const sameLogicalElement = (left: GeminiPart, right: GeminiPart): boolean => {
  if (left.text !== undefined || right.text !== undefined) {
    return left.text !== undefined && right.text !== undefined && (left.thought === true) === (right.thought === true);
  }
  if (left.functionCall !== undefined || right.functionCall !== undefined) {
    if (left.functionCall === undefined || right.functionCall === undefined) return false;
    if (left.functionCall.id !== undefined && right.functionCall.id !== undefined) {
      return left.functionCall.id === right.functionCall.id;
    }
    return left.functionCall.name === right.functionCall.name;
  }
  return false;
};

const firstElementIndexes = (parts: readonly GeminiPart[]): number[] => {
  const first = parts.findIndex(hasPartData);
  if (first === -1) return [];
  const indexes = [first];
  let previous = parts[first];
  for (let index = first + 1; index < parts.length; index += 1) {
    const part = parts[index];
    if (!hasPartData(part)) {
      if (part.thoughtSignature !== undefined) indexes.push(index);
      continue;
    }
    if (!sameLogicalElement(previous, part)) break;
    indexes.push(index);
    previous = part;
  }
  return indexes;
};

const lastContentPartIndex = (parts: readonly GeminiPart[]): number | undefined => {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (hasPartData(parts[index])) return index;
  }
  return undefined;
};

const firstContentPart = (parts: readonly GeminiPart[]): GeminiPart | undefined =>
  parts.find(hasPartData);

const candidateByIndex = (event: GeminiStreamEvent | undefined, index: number): GeminiCandidate | undefined =>
  event !== undefined && !('error' in event) ? event.candidates?.find(candidate => candidate.index === index) : undefined;

const removeEmptySignatureParts = (candidate: GeminiCandidate): void => {
  candidate.content.parts = candidate.content.parts.filter(part => hasPartData(part) || part.thoughtSignature !== undefined);
};

const relocateLeadingSignature = (
  current: GeminiCandidate,
  next: GeminiCandidate | undefined,
): void => {
  if (next === undefined || current.finishReason !== undefined) return;
  const targetIndex = lastContentPartIndex(current.content.parts);
  if (targetIndex === undefined) return;
  let signatureOnly: GeminiPart | undefined;
  for (const part of next.content.parts) {
    if (hasPartData(part)) break;
    if (part.thoughtSignature !== undefined) {
      signatureOnly = part;
      break;
    }
  }
  if (signatureOnly?.thoughtSignature === undefined) return;

  current.content.parts[targetIndex] = {
    ...current.content.parts[targetIndex],
    thoughtSignature: signatureOnly.thoughtSignature,
  };
  delete signatureOnly.thoughtSignature;
  removeEmptySignatureParts(next);
  if (next.content.parts.length === 0 && next.finishReason !== undefined) {
    current.finishReason = next.finishReason;
    delete next.finishReason;
  }
};

const wrapEvent = async (
  current: GeminiStreamEvent,
  next: GeminiStreamEvent | undefined,
  states: Map<number, CandidateState>,
  options: AffinityEgressOptions,
  allowSynthetic: boolean,
): Promise<GeminiStreamEvent> => {
  if ('error' in current) return current;

  for (const candidate of current.candidates ?? []) {
    const state = states.get(candidate.index) ?? { anchored: false, finished: false };
    if (state.finished) throw new Error(`Gemini candidate ${candidate.index} emitted data after its finishReason`);
    states.set(candidate.index, state);

    const nextCandidate = candidateByIndex(next, candidate.index);
    relocateLeadingSignature(candidate, nextCandidate);
    const firstIndexes = firstElementIndexes(candidate.content.parts);
    const firstHasNatural = firstIndexes.some(index => candidate.content.parts[index].thoughtSignature !== undefined);
    const lastFirstContentIndex = firstIndexes.findLast(index => hasPartData(candidate.content.parts[index]));
    const nextFirst = nextCandidate === undefined ? undefined : firstContentPart(nextCandidate.content.parts);
    const currentLast = lastFirstContentIndex === undefined ? undefined : candidate.content.parts[lastFirstContentIndex];
    const naturalContinuesImmediately = !firstHasNatural
      && currentLast !== undefined
      && nextFirst !== undefined
      && sameLogicalElement(currentLast, nextFirst)
      && nextFirst.thoughtSignature !== undefined;

    for (const part of candidate.content.parts) {
      if (part.thoughtSignature === undefined) continue;
      part.thoughtSignature = await options.codec.wrap(part.thoughtSignature, options.affinity, GEMINI_AFFINITY_DOMAIN);
    }

    if (!state.anchored) {
      if (firstHasNatural || naturalContinuesImmediately) {
        state.anchored = true;
      } else if (lastFirstContentIndex !== undefined && (next !== undefined || candidate.finishReason !== undefined || allowSynthetic)) {
        candidate.content.parts[lastFirstContentIndex] = {
          ...candidate.content.parts[lastFirstContentIndex],
          thoughtSignature: await options.codec.wrap(undefined, options.affinity, GEMINI_AFFINITY_DOMAIN),
        };
        state.anchored = true;
      } else if (candidate.finishReason !== undefined) {
        candidate.content.parts.push({
          thoughtSignature: await options.codec.wrap(
            undefined,
            { ...options.affinity, syntheticItem: true },
            GEMINI_AFFINITY_DOMAIN,
          ),
        });
        state.anchored = true;
      }
    }

    if (candidate.finishReason !== undefined) state.finished = true;
  }

  if (next !== undefined && !('error' in next) && next.candidates !== undefined) {
    next.candidates = next.candidates.filter(candidate => candidate.content.parts.length > 0 || candidate.finishReason !== undefined);
  }
  return current;
};

export const wrapGeminiAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const states = new Map<number, CandidateState>();
  let pending: GeminiStreamEvent | undefined;

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (pending !== undefined) {
        yield eventFrame(await wrapEvent(pending, undefined, states, options, frame.type === 'done'));
        pending = undefined;
      }
      yield frame;
      continue;
    }
    if ('error' in frame.event) {
      if (pending !== undefined) yield eventFrame(await wrapEvent(pending, undefined, states, options, false));
      yield frame;
      return;
    }

    const next = structuredClone(frame.event);
    if (pending !== undefined) yield eventFrame(await wrapEvent(pending, next, states, options, true));
    pending = next;
  }

  if (pending !== undefined) yield eventFrame(await wrapEvent(pending, undefined, states, options, false));
};
