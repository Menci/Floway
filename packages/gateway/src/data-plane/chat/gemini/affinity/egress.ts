import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { captureExtras, eventFrame, type ProtocolFrame, USAGE_BILLING } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiPart, GeminiResult, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

const KNOWN_EVENT_KEYS = new Set(['candidates', 'usageMetadata', 'modelVersion', 'responseId']);
const KNOWN_CANDIDATE_KEYS = new Set(['index', 'content', 'finishReason']);

// Gemini pays one upstream event of TTFT/inter-event latency. Within one event
// repeated snapshots collapse to one signature on the element's first
// content-bearing Part; across events the window can move a late signature
// back only onto the immediately preceding buffered chunk.
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
export const wrapGeminiAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const anchoredCandidates = new Set<number>();
  const suppressedEvents = new WeakSet<GeminiResult>();
  let pending: GeminiResult | undefined;
  const iterator = frames[Symbol.asyncIterator]();
  let sourceCompleted = false;

  try {
    while (true) {
      let result: IteratorResult<ProtocolFrame<GeminiStreamEvent>>;
      try {
        result = await iterator.next();
      } catch (error) {
        if (pending !== undefined) {
          const wrapped = await wrapGeminiEventAffinity(
            pending,
            undefined,
            anchoredCandidates,
            suppressedEvents,
            options,
            false,
          );
          if (!suppressedEvents.has(wrapped)) yield eventFrame(wrapped);
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
          const wrapped = await wrapGeminiEventAffinity(
            pending,
            undefined,
            anchoredCandidates,
            suppressedEvents,
            options,
            frame.type === 'done',
          );
          if (!suppressedEvents.has(wrapped)) yield eventFrame(wrapped);
          pending = undefined;
        }
        yield frame;
        continue;
      }
      if ('error' in frame.event) {
        if (pending !== undefined) {
          const wrapped = await wrapGeminiEventAffinity(
            pending,
            undefined,
            anchoredCandidates,
            suppressedEvents,
            options,
            false,
          );
          if (!suppressedEvents.has(wrapped)) yield eventFrame(wrapped);
        }
        yield frame;
        return;
      }

      const next = cloneGeminiEvent(frame.event);
      if (pending !== undefined) {
        const wrapped = await wrapGeminiEventAffinity(
          pending,
          next,
          anchoredCandidates,
          suppressedEvents,
          options,
          false,
        );
        if (!suppressedEvents.has(wrapped)) yield eventFrame(wrapped);
      }
      pending = next;
    }
  } finally {
    if (!sourceCompleted) await iterator.return?.();
  }

  if (pending !== undefined) {
    const wrapped = await wrapGeminiEventAffinity(
      pending,
      undefined,
      anchoredCandidates,
      suppressedEvents,
      options,
      false,
    );
    if (!suppressedEvents.has(wrapped)) yield eventFrame(wrapped);
  }
};

const cloneGeminiEvent = (event: GeminiResult): GeminiResult => {
  const cloned = structuredClone(event);
  const billing = event.usageMetadata?.[USAGE_BILLING];
  if (billing === undefined) return cloned;
  if (cloned.usageMetadata === undefined) {
    throw new Error('Gemini usage billing metadata lost its usage container during affinity cloning');
  }
  cloned.usageMetadata[USAGE_BILLING] = structuredClone(billing);
  return cloned;
};

const wrapGeminiEventAffinity = async (
  current: GeminiResult,
  next: GeminiResult | undefined,
  anchoredCandidates: Set<number>,
  suppressedEvents: WeakSet<GeminiResult>,
  options: AffinityEgressOptions,
  successfulTerminalBoundary: boolean,
): Promise<GeminiResult> => {
  const currentHadCandidates = (current.candidates?.length ?? 0) > 0;
  const nextHadCandidates = (next?.candidates?.length ?? 0) > 0;
  const removedCandidates = new WeakSet<GeminiCandidate>();

  for (const candidate of current.candidates ?? []) {
    const nextCandidate = next?.candidates?.find(nextCandidate => nextCandidate.index === candidate.index);
    normalizeElementSignatures(candidate);
    if (nextCandidate !== undefined) normalizeElementSignatures(nextCandidate);
    relocateSignatureOnlyForward(candidate, nextCandidate, removedCandidates);
    relocateSignatureOnlyBackward(candidate, nextCandidate, removedCandidates);
    relocateContinuationSignature(candidate, nextCandidate);
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
      || (nextCandidate !== undefined && nextContent === undefined && !removedCandidates.has(nextCandidate))
      || (nextCandidate !== undefined && nextContent !== undefined && !continuesInNextEvent)
      || (next === undefined && successfulTerminalBoundary);

    for (const part of candidate.content.parts) {
      if (part.thoughtSignature === undefined) continue;
      part.thoughtSignature = await options.codec.wrap(part.thoughtSignature, options.affinity, 'gemini.part.thoughtSignature');
    }

    if (anchoredCandidates.has(candidate.index)) continue;
    if (firstHasNatural || signatureOnlyNatural) {
      anchoredCandidates.add(candidate.index);
    } else if (firstContentIndex !== undefined && firstElementClosed) {
      candidate.content.parts[firstContentIndex] = {
        ...candidate.content.parts[firstContentIndex],
        thoughtSignature: await options.codec.wrap(undefined, options.affinity, 'gemini.part.thoughtSignature'),
      };
      anchoredCandidates.add(candidate.index);
    } else if (candidate.finishReason !== undefined) {
      candidate.content.parts.push({
        thoughtSignature: await options.codec.wrap(
          undefined,
          { ...options.affinity, syntheticItem: true },
          'gemini.part.thoughtSignature',
        ),
      });
      anchoredCandidates.add(candidate.index);
    }
  }

  if (next?.candidates !== undefined) {
    next.candidates = next.candidates.filter(candidate => !removedCandidates.has(candidate));
  }
  if (current.candidates !== undefined) {
    current.candidates = current.candidates.filter(candidate => !removedCandidates.has(candidate));
  }
  const currentEmptied = currentHadCandidates && current.candidates?.length === 0;
  const nextEmptied = nextHadCandidates && next?.candidates?.length === 0;
  if (currentEmptied && next !== undefined && !nextEmptied) {
    mergeEventMetadata(current, next, next);
    clearEventMetadata(current);
    suppressedEvents.add(current);
  } else if (nextEmptied && next !== undefined && !currentEmptied) {
    mergeEventMetadata(current, next, current);
    clearEventMetadata(next);
    suppressedEvents.add(next);
  }
  return current;
};

const normalizeElementSignatures = (candidate: GeminiCandidate): void => {
  const parts = candidate.content.parts;
  const signatureParts = new Set(parts.filter(part => part.thoughtSignature !== undefined));
  for (const indexes of logicalElementGroups(parts)) normalizeElementSignature(parts, indexes);
  removeRelocatedSignatureParts(candidate, signatureParts);
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

const relocateSignatureOnlyForward = (
  current: GeminiCandidate,
  next: GeminiCandidate | undefined,
  removedCandidates: WeakSet<GeminiCandidate>,
): void => {
  if (
    next === undefined
    || current.finishReason !== undefined
    || current.content.parts.some(hasPartContent)
  ) return;
  const relocated = new Set(current.content.parts.filter(part => part.thoughtSignature !== undefined));
  const signature = relocated.values().next().value?.thoughtSignature;
  const targetIndex = firstElementIndexes(next.content.parts).find(index => hasPartContent(next.content.parts[index]));
  if (signature === undefined || targetIndex === undefined) return;
  next.content.parts[targetIndex].thoughtSignature ??= signature;
  for (const part of relocated) delete part.thoughtSignature;
  removeRelocatedSignatureParts(current, relocated, removedCandidates);
  if (current.content.parts.length === 0) transferCandidateMetadataForward(current, next);
};

const relocateSignatureOnlyBackward = (
  current: GeminiCandidate,
  next: GeminiCandidate | undefined,
  removedCandidates: WeakSet<GeminiCandidate>,
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
  removeRelocatedSignatureParts(next, new Set([signatureOnly]), removedCandidates);
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

const removeRelocatedSignatureParts = (
  candidate: GeminiCandidate,
  relocated: ReadonlySet<GeminiPart>,
  removedCandidates?: WeakSet<GeminiCandidate>,
): void => {
  candidate.content.parts = candidate.content.parts.filter(part =>
    !relocated.has(part) || hasPartContent(part) || part.thoughtSignature !== undefined);
  if (candidate.content.parts.length === 0) removedCandidates?.add(candidate);
};

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
    // Name/shape cannot distinguish a continuation from two adjacent complete
    // id-less calls, so ambiguous or asymmetric-ID calls remain separate.
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

const mergeEventMetadata = (
  earlier: GeminiResult,
  later: GeminiResult,
  target: GeminiResult,
): void => {
  const extras: Record<string, unknown> = {};
  captureExtras(earlier as unknown as Record<string, unknown>, KNOWN_EVENT_KEYS, extras);
  captureExtras(later as unknown as Record<string, unknown>, KNOWN_EVENT_KEYS, extras);
  const usageMetadata = later.usageMetadata ?? earlier.usageMetadata;
  const modelVersion = later.modelVersion ?? earlier.modelVersion;
  const responseId = later.responseId ?? earlier.responseId;
  for (const key of Object.keys(target)) if (key !== 'candidates') delete (target as Record<string, unknown>)[key];
  Object.assign(target, {
    ...(usageMetadata !== undefined ? { usageMetadata } : {}),
    ...(modelVersion !== undefined ? { modelVersion } : {}),
    ...(responseId !== undefined ? { responseId } : {}),
    ...extras,
  });
};

const clearEventMetadata = (event: GeminiResult): void => {
  for (const key of Object.keys(event)) if (key !== 'candidates') delete (event as Record<string, unknown>)[key];
};

const mergeCandidateExtras = (
  earlier: GeminiCandidate,
  later: GeminiCandidate,
  target: GeminiCandidate,
): void => {
  const extras: Record<string, unknown> = {};
  captureExtras(earlier as unknown as Record<string, unknown>, KNOWN_CANDIDATE_KEYS, extras);
  captureExtras(later as unknown as Record<string, unknown>, KNOWN_CANDIDATE_KEYS, extras);
  for (const key of Object.keys(target)) {
    if (!KNOWN_CANDIDATE_KEYS.has(key)) delete (target as unknown as Record<string, unknown>)[key];
  }
  Object.assign(target, extras);
};

const transferCandidateMetadata = (current: GeminiCandidate, next: GeminiCandidate): void => {
  mergeCandidateExtras(current, next, current);
  if (next.content.role !== undefined) current.content.role = next.content.role;
  if (next.finishReason !== undefined) current.finishReason = next.finishReason;
};

const transferCandidateMetadataForward = (current: GeminiCandidate, next: GeminiCandidate): void => {
  mergeCandidateExtras(current, next, next);
  if (next.content.role === undefined && current.content.role !== undefined) next.content.role = current.content.role;
};
