import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
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
    return false;
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

// Gemini pays one upstream-event of TTFT/inter-event latency so the client sees
// one authoritative signature on a content-bearing Part. Repeating synthetic
// then natural signatures is unsafe: streamed function calls are first-wins in
// Vercel/Google ADKs, while LangChain Python concatenates same-index strings.
// A sliding window holds only the newest same-element event until a signature
// or boundary arrives; older visible events keep flowing without a signature.
// https://github.com/vercel/ai/blob/2c080eae3da9294d992cae5df22c2d7e1d38b571/packages/google/src/google-language-model.ts#L620-L665
// https://github.com/langchain-ai/langchain/blob/7bf8fe22163e5dadce365169e2df6b91233de9c4/libs/core/langchain_core/utils/_merge.py#L6-L70
// Signature-only Parts are also rejected from Go Chat history:
// https://github.com/googleapis/go-genai/blob/dc282483e1a68eaeb64faa9fa9877dd4a7ad1887/chats.go#L49-L75
// This deliberately favors direct GenAI Chat compatibility by moving an
// immediate signature-only trailer onto content. Google ADK text aggregation
// can drop that metadata, and a natural function signature arriving more than
// one continuation after the first chunk still cannot repair first-chunk-wins
// clients without buffering the whole logical element.

const removeEmptySignatureParts = (candidate: GeminiCandidate): void => {
  candidate.content.parts = candidate.content.parts.filter(part => hasPartData(part) || part.thoughtSignature !== undefined);
};

const normalizeElementSignature = (parts: GeminiPart[], indexes: readonly number[]): void => {
  const signatures = indexes.flatMap(index => {
    const signature = parts[index].thoughtSignature;
    return signature === undefined ? [] : [signature];
  });
  if (signatures.length === 0) return;
  const targetIndex = indexes.findLast(index => hasPartData(parts[index])) ?? indexes.at(-1);
  if (targetIndex === undefined) throw new Error('Gemini signature group has no target Part');
  for (const index of indexes) delete parts[index].thoughtSignature;
  parts[targetIndex].thoughtSignature = signatures[signatures.length - 1];
};

const normalizeElementSignatures = (candidate: GeminiCandidate): void => {
  const parts = candidate.content.parts;
  let group: number[] = [];
  let previousContent: GeminiPart | undefined;
  const flush = () => {
    normalizeElementSignature(parts, group);
    group = [];
    previousContent = undefined;
  };
  for (const [index, part] of parts.entries()) {
    if (!hasPartData(part)) {
      if (part.thoughtSignature !== undefined) group.push(index);
      continue;
    }
    if (previousContent !== undefined && !sameLogicalElement(previousContent, part)) flush();
    group.push(index);
    previousContent = part;
  }
  flush();
  removeEmptySignatureParts(candidate);
};

const transferCandidateMetadata = (current: GeminiCandidate, next: GeminiCandidate): void => {
  const currentRecord = current as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(nextRecord)) {
    if (key !== 'index' && key !== 'content' && key !== 'finishReason') currentRecord[key] = value;
  }
  if (next.content.role !== undefined) current.content.role = next.content.role;
  if (next.finishReason !== undefined) current.finishReason = next.finishReason;
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
  if (next.content.parts.length === 0) {
    transferCandidateMetadata(current, next);
    delete next.finishReason;
  }
};

const relocateContinuationSignature = (
  current: GeminiCandidate,
  next: GeminiCandidate | undefined,
): void => {
  if (next === undefined || current.finishReason !== undefined) return;
  const targetIndex = lastContentPartIndex(current.content.parts);
  const nextPart = firstContentPart(next.content.parts);
  if (
    targetIndex === undefined
    || nextPart?.thoughtSignature === undefined
    || !sameLogicalElement(current.content.parts[targetIndex], nextPart)
  ) return;
  current.content.parts[targetIndex] = {
    ...current.content.parts[targetIndex],
    thoughtSignature: nextPart.thoughtSignature,
  };
  delete nextPart.thoughtSignature;
};

const foldEmptyTerminalCandidate = (
  current: GeminiCandidate,
  next: GeminiCandidate | undefined,
): void => {
  if (next === undefined || next.content.parts.length > 0 || next.finishReason === undefined) return;
  transferCandidateMetadata(current, next);
  delete next.finishReason;
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
    relocateContinuationSignature(candidate, nextCandidate);
    foldEmptyTerminalCandidate(candidate, nextCandidate);
    normalizeElementSignatures(candidate);
    const firstIndexes = firstElementIndexes(candidate.content.parts);
    const firstHasNatural = firstIndexes.some(index => candidate.content.parts[index].thoughtSignature !== undefined);
    const signatureOnlyNatural = firstIndexes.length === 0
      && candidate.content.parts.some(part => part.thoughtSignature !== undefined);
    const lastFirstContentIndex = firstIndexes.findLast(index => hasPartData(candidate.content.parts[index]));
    const firstContent = lastFirstContentIndex === undefined ? undefined : candidate.content.parts[lastFirstContentIndex];
    const nextContent = nextCandidate === undefined ? undefined : firstContentPart(nextCandidate.content.parts);
    const continuesInNextEvent = firstContent !== undefined
      && nextContent !== undefined
      && sameLogicalElement(firstContent, nextContent);
    const startsAnotherElementInCurrentEvent = lastFirstContentIndex !== undefined
      && candidate.content.parts.slice(lastFirstContentIndex + 1).some(hasPartData);
    const firstElementClosed = startsAnotherElementInCurrentEvent
      || candidate.finishReason !== undefined
      || (next !== undefined && nextCandidate === undefined)
      || (nextCandidate !== undefined && nextContent !== undefined && !continuesInNextEvent)
      || (next === undefined && allowSynthetic);

    for (const part of candidate.content.parts) {
      if (part.thoughtSignature === undefined) continue;
      part.thoughtSignature = await options.codec.wrap(part.thoughtSignature, options.affinity, 'gemini.part.thoughtSignature');
    }

    if (!state.anchored) {
      if (firstHasNatural || signatureOnlyNatural) {
        state.anchored = true;
      } else if (lastFirstContentIndex !== undefined && firstElementClosed) {
        candidate.content.parts[lastFirstContentIndex] = {
          ...candidate.content.parts[lastFirstContentIndex],
          thoughtSignature: await options.codec.wrap(undefined, options.affinity, 'gemini.part.thoughtSignature'),
        };
        state.anchored = true;
      } else if (candidate.finishReason !== undefined) {
        candidate.content.parts.push({
          thoughtSignature: await options.codec.wrap(
            undefined,
            { ...options.affinity, syntheticItem: true },
            'gemini.part.thoughtSignature',
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
