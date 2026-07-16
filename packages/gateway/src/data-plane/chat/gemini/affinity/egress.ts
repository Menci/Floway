import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame, USAGE_BILLING } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiPart, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

interface CandidateState {
  anchored: boolean;
  finished: boolean;
}

const hasPartContent = (part: GeminiPart): boolean => {
  const { text, thought: _thought, thoughtSignature: _signature, ...data } = part;
  return (typeof text === 'string' && text.length > 0) || Object.keys(data).length > 0;
};

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

const logicalElementGroups = (parts: readonly GeminiPart[]): number[][] => {
  const groups: number[][] = [];
  let indexes: number[] = [];
  let previousContent: GeminiPart | undefined;
  const flush = () => {
    if (indexes.length > 0) groups.push(indexes);
    indexes = [];
    previousContent = undefined;
  };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!hasPartContent(part)) {
      if (part.thoughtSignature !== undefined) indexes.push(index);
      continue;
    }
    if (previousContent !== undefined && !sameLogicalElement(previousContent, part)) flush();
    indexes.push(index);
    previousContent = part;
  }
  flush();
  return groups;
};

const firstElementIndexes = (parts: readonly GeminiPart[]): number[] =>
  logicalElementGroups(parts).find(indexes => indexes.some(index => hasPartContent(parts[index]))) ?? [];

const firstContentIndexOfLastElement = (parts: readonly GeminiPart[]): number | undefined =>
  logicalElementGroups(parts)
    .findLast(indexes => indexes.some(index => hasPartContent(parts[index])))
    ?.find(index => hasPartContent(parts[index]));

const firstContentPart = (parts: readonly GeminiPart[]): GeminiPart | undefined =>
  parts.find(hasPartContent);

const candidateByIndex = (event: GeminiStreamEvent | undefined, index: number): GeminiCandidate | undefined =>
  event !== undefined && !('error' in event) ? event.candidates?.find(candidate => candidate.index === index) : undefined;

// Gemini pays one upstream-event of TTFT/inter-event latency so the client sees
// one authoritative signature. Within one event it belongs on the first Part
// of its logical element; across events the window can move it back only onto
// the immediately preceding buffered chunk.
// Repeating synthetic then natural signatures is unsafe: Vercel and Google ADK
// retain the metadata captured when a streamed function call starts, while
// LangChain Python concatenates same-index strings.
// A sliding window holds only the newest same-element event until a signature
// or boundary arrives; older visible events keep flowing without a signature.
// https://github.com/vercel/ai/blob/2c080eae3da9294d992cae5df22c2d7e1d38b571/packages/google/src/google-language-model.ts#L638-L668
// https://github.com/vercel/ai/blob/2c080eae3da9294d992cae5df22c2d7e1d38b571/packages/google/src/google-language-model.ts#L946-L962
// https://github.com/google/adk-js/blob/ca2209b68c2fee3c84ea7d90e050ca2fe9951193/core/src/utils/streaming_utils.ts#L201-L215
// https://github.com/langchain-ai/langchain/blob/7bf8fe22163e5dadce365169e2df6b91233de9c4/libs/core/langchain_core/utils/_merge.py#L6-L70
// Signature-only Parts are also rejected from Go Chat history:
// https://github.com/googleapis/go-genai/blob/dc282483e1a68eaeb64faa9fa9877dd4a7ad1887/chats.go#L49-L75
// This deliberately favors direct GenAI Chat compatibility by moving an
// immediate signature-only trailer onto content. Google ADK text aggregation
// drops signature metadata when it combines text chunks, and a natural
// function signature arriving more than one continuation after the first
// chunk still cannot repair first-chunk-wins clients without buffering the
// whole logical element.
// https://github.com/google/adk-js/blob/ca2209b68c2fee3c84ea7d90e050ca2fe9951193/core/src/utils/streaming_utils.ts#L227-L250

const removeEmptySignatureParts = (candidate: GeminiCandidate): void => {
  candidate.content.parts = candidate.content.parts.filter(part => hasPartContent(part) || part.thoughtSignature !== undefined);
};

const normalizeElementSignature = (parts: GeminiPart[], indexes: readonly number[]): void => {
  const signatures = indexes.flatMap(index => {
    const signature = parts[index].thoughtSignature;
    return signature === undefined ? [] : [signature];
  });
  if (signatures.length === 0) return;
  const targetIndex = indexes.find(index => hasPartContent(parts[index])) ?? indexes.at(-1);
  if (targetIndex === undefined) throw new Error('Gemini signature group has no target Part');
  for (const index of indexes) delete parts[index].thoughtSignature;
  parts[targetIndex].thoughtSignature = signatures[signatures.length - 1];
};

const normalizeElementSignatures = (candidate: GeminiCandidate): void => {
  const parts = candidate.content.parts;
  for (const indexes of logicalElementGroups(parts)) normalizeElementSignature(parts, indexes);
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

const transferCandidateMetadataForward = (current: GeminiCandidate, next: GeminiCandidate): void => {
  const currentRecord = current as unknown as Record<string, unknown>;
  const nextRecord = next as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(currentRecord)) {
    if (key !== 'index' && key !== 'content' && key !== 'finishReason' && nextRecord[key] === undefined) {
      nextRecord[key] = value;
    }
  }
  if (next.content.role === undefined && current.content.role !== undefined) next.content.role = current.content.role;
};

const relocateSignatureOnlyForward = (
  current: GeminiCandidate,
  next: GeminiCandidate | undefined,
): void => {
  if (
    next === undefined
    || current.finishReason !== undefined
    || current.content.parts.some(hasPartContent)
  ) return;
  const signature = current.content.parts.find(part => part.thoughtSignature !== undefined)?.thoughtSignature;
  const targetIndex = firstElementIndexes(next.content.parts).find(index => hasPartContent(next.content.parts[index]));
  if (signature === undefined || targetIndex === undefined) return;
  if (next.content.parts[targetIndex].thoughtSignature === undefined) {
    next.content.parts[targetIndex].thoughtSignature = signature;
  }
  for (const part of current.content.parts) delete part.thoughtSignature;
  removeEmptySignatureParts(current);
  if (current.content.parts.length === 0) transferCandidateMetadataForward(current, next);
};

const relocateSignatureOnlyBackward = (
  current: GeminiCandidate,
  next: GeminiCandidate | undefined,
): void => {
  if (
    next === undefined
    || current.finishReason !== undefined
    || next.content.parts.some(hasPartContent)
  ) return;
  const targetIndex = firstContentIndexOfLastElement(current.content.parts);
  if (targetIndex === undefined) return;
  const signatureOnly = next.content.parts.find(part => part.thoughtSignature !== undefined);
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
  const targetIndex = firstContentIndexOfLastElement(current.content.parts);
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
    normalizeElementSignatures(candidate);
    if (nextCandidate !== undefined) normalizeElementSignatures(nextCandidate);
    relocateSignatureOnlyForward(candidate, nextCandidate);
    relocateSignatureOnlyBackward(candidate, nextCandidate);
    relocateContinuationSignature(candidate, nextCandidate);
    foldEmptyTerminalCandidate(candidate, nextCandidate);
    const firstIndexes = firstElementIndexes(candidate.content.parts);
    const firstHasNatural = firstIndexes.some(index => candidate.content.parts[index].thoughtSignature !== undefined);
    const signatureOnlyNatural = firstIndexes.length === 0
      && candidate.content.parts.some(part => part.thoughtSignature !== undefined);
    const firstContentIndex = firstIndexes.find(index => hasPartContent(candidate.content.parts[index]));
    const lastFirstContentIndex = firstIndexes.findLast(index => hasPartContent(candidate.content.parts[index]));
    const firstContent = lastFirstContentIndex === undefined ? undefined : candidate.content.parts[lastFirstContentIndex];
    const nextContent = nextCandidate === undefined ? undefined : firstContentPart(nextCandidate.content.parts);
    const continuesInNextEvent = firstContent !== undefined
      && nextContent !== undefined
      && sameLogicalElement(firstContent, nextContent);
    const startsAnotherElementInCurrentEvent = lastFirstContentIndex !== undefined
      && candidate.content.parts.slice(lastFirstContentIndex + 1).some(hasPartContent);
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
      } else if (firstContentIndex !== undefined && firstElementClosed) {
        candidate.content.parts[firstContentIndex] = {
          ...candidate.content.parts[firstContentIndex],
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
  if (current.candidates !== undefined) {
    current.candidates = current.candidates.filter(candidate => candidate.content.parts.length > 0 || candidate.finishReason !== undefined);
  }
  return current;
};

const cloneGeminiEvent = (event: GeminiStreamEvent): GeminiStreamEvent => {
  const cloned = structuredClone(event);
  if ('error' in event) return cloned;
  const billing = event.usageMetadata?.[USAGE_BILLING];
  if (billing === undefined) return cloned;
  if ('error' in cloned || cloned.usageMetadata === undefined) {
    throw new Error('Gemini usage billing metadata lost its usage container during affinity cloning');
  }
  cloned.usageMetadata[USAGE_BILLING] = structuredClone(billing);
  return cloned;
};

export const wrapGeminiAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const states = new Map<number, CandidateState>();
  let pending: GeminiStreamEvent | undefined;
  const iterator = frames[Symbol.asyncIterator]();
  let sourceCompleted = false;

  try {
    while (true) {
      let result: IteratorResult<ProtocolFrame<GeminiStreamEvent>>;
      try {
        result = await iterator.next();
      } catch (error) {
        if (pending !== undefined) {
          yield eventFrame(await wrapEvent(pending, undefined, states, options, false));
          pending = undefined;
        }
        throw error;
      }
      if (result.done) {
        sourceCompleted = true;
        break;
      }
      const frame = result.value;
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

      const next = cloneGeminiEvent(frame.event);
      if (pending !== undefined) yield eventFrame(await wrapEvent(pending, next, states, options, true));
      pending = next;
    }
  } finally {
    if (!sourceCompleted) await iterator.return?.();
  }

  if (pending !== undefined) yield eventFrame(await wrapEvent(pending, undefined, states, options, false));
};
