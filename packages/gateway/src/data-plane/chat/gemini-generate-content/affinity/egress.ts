import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { captureExtras, eventFrame, withIndexesChanged, withKeysChanged, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentCandidate, GeminiGenerateContentPart, GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, GEMINI_GENERATE_CONTENT_RESULT_KEYS } from '@floway-dev/protocols/gemini-generate-content';

// Gemini generateContent pays one upstream event of TTFT/inter-event latency. Within one event
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
export const wrapGeminiGenerateContentAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const anchoredCandidates = new Set<number>();
  // The one event held back, and what the pass that produced it decided about emitting it.
  // Both used to be recorded against the event object — the verdict in a `WeakSet`, the
  // rewrites by assignment — which only works while an event can be written in place. Nothing
  // here is written in place any more, so a pass hands back new events and the verdict travels
  // beside the one it is about rather than being looked up by identity.
  let pending: PendingEvent | undefined;
  const iterator = frames[Symbol.asyncIterator]();
  let sourceCompleted = false;

  try {
    while (true) {
      let result: IteratorResult<ProtocolFrame<GeminiGenerateContentStreamEvent>>;
      try {
        result = await iterator.next();
      } catch (error) {
        if (pending !== undefined) {
          const flushed = await flushPending(pending, anchoredCandidates, options, false);
          if (flushed !== undefined) yield eventFrame(flushed);
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
          const flushed = await flushPending(pending, anchoredCandidates, options, frame.type === 'done');
          if (flushed !== undefined) yield eventFrame(flushed);
          pending = undefined;
        }
        yield frame;
        continue;
      }
      if ('error' in frame.event) {
        if (pending !== undefined) {
          const flushed = await flushPending(pending, anchoredCandidates, options, false);
          if (flushed !== undefined) yield eventFrame(flushed);
        }
        yield frame;
        return;
      }

      if (pending === undefined) {
        pending = { event: frame.event, suppressed: false };
        continue;
      }
      const pass = await passOverEventPair(pending, frame.event, anchoredCandidates, options, false);
      if (!pass.current.suppressed) yield eventFrame(pass.current.event);
      pending = pass.next;
    }
  } finally {
    if (!sourceCompleted) await iterator.return?.();
  }

  if (pending !== undefined) {
    const flushed = await flushPending(pending, anchoredCandidates, options, false);
    if (flushed !== undefined) yield eventFrame(flushed);
  }
};

/** One event, and whether the pass that produced it already decided it is not to be emitted. */
interface PendingEvent {
  readonly event: GeminiGenerateContentResult;
  readonly suppressed: boolean;
}

/** The last pass an event gets: there is no successor, so nothing can move forward out of it.
 *  Returns what to emit, or nothing where the event was suppressed. */
const flushPending = async (
  pending: PendingEvent,
  anchoredCandidates: Set<number>,
  options: AffinityEgressOptions,
  successfulTerminalBoundary: boolean,
): Promise<GeminiGenerateContentResult | undefined> => {
  const pass = await passOverEventPair(pending, undefined, anchoredCandidates, options, successfulTerminalBoundary);
  return pass.current.suppressed ? undefined : pass.current.event;
};

/** What one relocation hands on: the pair as it now stands, and whether either side was left
 *  with no Parts at all — which is the pair's own statement that the candidate should not be
 *  emitted. This used to be a `WeakSet` of the candidates a relocation emptied; a rebuilt
 *  candidate is a different object, so the verdict is carried rather than looked up. */
interface CandidatePair {
  readonly current: GeminiGenerateContentCandidate;
  readonly next: GeminiGenerateContentCandidate | undefined;
  readonly currentRemoved: boolean;
  readonly nextRemoved: boolean;
}

/** A candidate with different Parts, or the same candidate where they did not change. */
const withParts = (
  candidate: GeminiGenerateContentCandidate,
  parts: readonly GeminiGenerateContentPart[],
): GeminiGenerateContentCandidate =>
  parts === candidate.content.parts
    ? candidate
    : { ...candidate, content: { ...candidate.content, parts: parts as GeminiGenerateContentPart[] } };

/** An event with different candidates. An event that declared none keeps declaring none: the
 *  absent key and the empty array say different things to a client. */
const withCandidates = (
  event: GeminiGenerateContentResult,
  candidates: readonly GeminiGenerateContentCandidate[],
): GeminiGenerateContentResult =>
  event.candidates === undefined || candidates === event.candidates
    ? event
    : { ...event, candidates: candidates as GeminiGenerateContentCandidate[] };

/**
 * One pass of the sliding window: the held event, the one behind it, and what becomes of both.
 *
 * Every rewrite here is a rebuild. A frame this transducer was handed belongs to the layer that
 * produced it, and the events it hands on are new objects that share everything the pass did not
 * touch — so a Part no rule spoke about is the same Part, and the pass costs what it changed
 * rather than a copy of the event.
 */
const passOverEventPair = async (
  pending: PendingEvent,
  nextEvent: GeminiGenerateContentResult | undefined,
  anchoredCandidates: Set<number>,
  options: AffinityEgressOptions,
  successfulTerminalBoundary: boolean,
): Promise<{ readonly current: PendingEvent; readonly next: PendingEvent | undefined }> => {
  const current = pending.event;
  const currentHadCandidates = (current.candidates?.length ?? 0) > 0;
  const nextHadCandidates = (nextEvent?.candidates?.length ?? 0) > 0;

  // The two arrays under construction. Their elements are replaced, never written into: what
  // goes back is whatever the rules built, and an untouched candidate goes back as itself.
  const builtCurrent = [...(current.candidates ?? [])];
  const builtNext = nextEvent === undefined ? undefined : [...(nextEvent.candidates ?? [])];
  const removedCurrent = new Set<number>();
  const removedNext = new Set<number>();

  for (let position = 0; position < builtCurrent.length; position += 1) {
    const nextPosition = builtNext?.findIndex(entry => entry.index === builtCurrent[position].index) ?? -1;
    const relocated = relocateContinuationSignature(relocateSignatureOnlyBackward(relocateSignatureOnlyForward({
      current: normalizeElementSignatures(builtCurrent[position]),
      next: nextPosition >= 0 ? normalizeElementSignatures(builtNext![nextPosition]) : undefined,
      currentRemoved: false,
      nextRemoved: false,
    })));
    let candidate = relocated.current;
    const nextCandidate = relocated.next;
    if (relocated.currentRemoved) removedCurrent.add(position);
    if (relocated.nextRemoved && nextPosition >= 0) removedNext.add(nextPosition);

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
      || (nextEvent !== undefined && nextCandidate === undefined)
      || (nextCandidate !== undefined && nextContent === undefined && !relocated.nextRemoved)
      || (nextCandidate !== undefined && nextContent !== undefined && !continuesInNextEvent)
      || (nextEvent === undefined && successfulTerminalBoundary);

    const wrapped: GeminiGenerateContentPart[] = [];
    for (const part of candidate.content.parts) {
      wrapped.push(part.thoughtSignature === undefined ? part : {
        ...part,
        thoughtSignature: await options.codec.wrap(part.thoughtSignature, options.affinity, 'gemini-generate-content.part.thoughtSignature'),
      });
    }
    candidate = withParts(candidate, wrapped);

    if (!anchoredCandidates.has(candidate.index)) {
      if (firstHasNatural || signatureOnlyNatural) {
        anchoredCandidates.add(candidate.index);
      } else if (firstContentIndex !== undefined && firstElementClosed) {
        candidate = withParts(candidate, withIndexesChanged(candidate.content.parts, new Map([[firstContentIndex, {
          ...candidate.content.parts[firstContentIndex],
          thoughtSignature: await options.codec.wrap(undefined, options.affinity, 'gemini-generate-content.part.thoughtSignature'),
        }]])));
        anchoredCandidates.add(candidate.index);
      } else if (candidate.finishReason !== undefined) {
        candidate = withParts(candidate, [...candidate.content.parts, {
          thoughtSignature: await options.codec.wrap(undefined, options.affinity, 'gemini-generate-content.part.thoughtSignature'),
        }]);
        anchoredCandidates.add(candidate.index);
      }
    }

    builtCurrent[position] = candidate;
    if (nextPosition >= 0 && nextCandidate !== undefined) builtNext![nextPosition] = nextCandidate;
  }

  const keptCurrent = builtCurrent.filter((_candidate, position) => !removedCurrent.has(position));
  const keptNext = builtNext?.filter((_candidate, position) => !removedNext.has(position));
  const currentEmptied = currentHadCandidates && keptCurrent.length === 0;
  const nextEmptied = nextHadCandidates && keptNext?.length === 0;

  let currentOut = withCandidates(current, keptCurrent);
  let nextOut = nextEvent === undefined ? undefined : withCandidates(nextEvent, keptNext ?? []);
  let currentSuppressed = pending.suppressed;
  let nextSuppressed = false;

  // An event whose every candidate moved into its neighbour has nothing left to say on its own,
  // so what it was carrying beside them moves too and the event itself is not emitted.
  if (currentEmptied && nextOut !== undefined && !nextEmptied) {
    nextOut = mergedEventMetadata(currentOut, nextOut, nextOut);
    currentOut = withoutEventMetadata(currentOut);
    currentSuppressed = true;
  } else if (nextEmptied && nextOut !== undefined && !currentEmptied) {
    currentOut = mergedEventMetadata(currentOut, nextOut, currentOut);
    nextOut = withoutEventMetadata(nextOut);
    nextSuppressed = true;
  }

  return {
    current: { event: currentOut, suppressed: currentSuppressed },
    next: nextOut === undefined ? undefined : { event: nextOut, suppressed: nextSuppressed },
  };
};

/** Every signature a logical element carries, collapsed onto that element's first
 *  content-bearing Part, and the signature-only Parts that leaves behind dropped. */
const normalizeElementSignatures = (candidate: GeminiGenerateContentCandidate): GeminiGenerateContentCandidate => {
  const parts = candidate.content.parts;
  const carriedSignature = new Set(parts.flatMap((part, index) => part.thoughtSignature === undefined ? [] : [index]));
  // The groups are index lists read off the Parts as they arrived, and collapsing a signature
  // never changes how many Parts there are, so they stay valid across the fold.
  let folded: readonly GeminiGenerateContentPart[] = parts;
  for (const indexes of logicalElementGroups(parts)) folded = normalizeElementSignature(folded, indexes);
  return withParts(candidate, keptAfterRelocation(folded, carriedSignature));
};

const normalizeElementSignature = (
  parts: readonly GeminiGenerateContentPart[],
  indexes: readonly number[],
): readonly GeminiGenerateContentPart[] => {
  const signatures = indexes.flatMap(index => {
    const signature = parts[index].thoughtSignature;
    return signature === undefined ? [] : [signature];
  });
  if (signatures.length === 0) return parts;
  const targetIndex = indexes.find(index => hasPartContent(parts[index])) ?? indexes.at(-1);
  if (targetIndex === undefined) throw new Error('Gemini generateContent signature group has no target Part');
  const rewrites = new Map<number, GeminiGenerateContentPart>(
    indexes.map(index => [index, withKeysChanged(parts[index], { thoughtSignature: undefined })]),
  );
  rewrites.set(targetIndex, withKeysChanged(parts[targetIndex], { thoughtSignature: signatures[signatures.length - 1] }));
  return parts.map((part, index) => rewrites.get(index) ?? part);
};

const relocateSignatureOnlyForward = (pair: CandidatePair): CandidatePair => {
  const { current, next } = pair;
  if (
    next === undefined
    || current.finishReason !== undefined
    || current.content.parts.some(hasPartContent)
  ) return pair;
  const relocated = new Set(current.content.parts.flatMap((part, index) => part.thoughtSignature === undefined ? [] : [index]));
  const signature = current.content.parts.find(part => part.thoughtSignature !== undefined)?.thoughtSignature;
  const targetIndex = firstElementIndexes(next.content.parts).find(index => hasPartContent(next.content.parts[index]));
  if (signature === undefined || targetIndex === undefined) return pair;

  // A target that already carries one keeps it: this moves a signature into a gap, never over
  // an upstream's own.
  const carried = next.content.parts[targetIndex].thoughtSignature !== undefined ? next : withParts(
    next,
    withIndexesChanged(next.content.parts, new Map([[targetIndex, withKeysChanged(next.content.parts[targetIndex], { thoughtSignature: signature })]])),
  );
  const strippedParts = keptAfterRelocation(
    current.content.parts.map(part => part.thoughtSignature === undefined ? part : withKeysChanged(part, { thoughtSignature: undefined })),
    relocated,
  );
  const stripped = withParts(current, strippedParts);
  return strippedParts.length > 0
    ? { ...pair, current: stripped, next: carried }
    : { ...pair, current: stripped, next: withForwardedCandidateMetadata(stripped, carried), currentRemoved: true };
};

const relocateSignatureOnlyBackward = (pair: CandidatePair): CandidatePair => {
  const { current, next } = pair;
  if (
    next === undefined
    || current.finishReason !== undefined
    || next.content.parts.some(hasPartContent)
  ) return pair;
  const targetIndex = firstContentIndexOfLastElement(current.content.parts);
  if (targetIndex === undefined) return pair;
  const signatureIndex = next.content.parts.findIndex(part => part.thoughtSignature !== undefined);
  const signature = signatureIndex < 0 ? undefined : next.content.parts[signatureIndex].thoughtSignature;
  if (signature === undefined) return pair;

  const anchored = withParts(
    current,
    withIndexesChanged(current.content.parts, new Map([[targetIndex, withKeysChanged(current.content.parts[targetIndex], { thoughtSignature: signature })]])),
  );
  const strippedParts = keptAfterRelocation(
    withIndexesChanged(next.content.parts, new Map([[signatureIndex, withKeysChanged(next.content.parts[signatureIndex], { thoughtSignature: undefined })]])),
    new Set([signatureIndex]),
  );
  const stripped = withParts(next, strippedParts);
  return strippedParts.length > 0
    ? { ...pair, current: anchored, next: stripped }
    : {
        ...pair,
        current: withCandidateMetadataFrom(anchored, stripped),
        next: withKeysChanged(stripped, { finishReason: undefined }),
        nextRemoved: true,
      };
};

const relocateContinuationSignature = (pair: CandidatePair): CandidatePair => {
  const { current, next } = pair;
  if (next === undefined || current.finishReason !== undefined) return pair;
  const targetIndex = firstContentIndexOfLastElement(current.content.parts);
  const nextIndex = next.content.parts.findIndex(hasPartContent);
  const nextPart = nextIndex < 0 ? undefined : next.content.parts[nextIndex];
  if (
    targetIndex === undefined
    || nextPart?.thoughtSignature === undefined
    || !sameLogicalElement(current.content.parts[targetIndex], nextPart)
  ) return pair;
  return {
    ...pair,
    current: withParts(
      current,
      withIndexesChanged(current.content.parts, new Map([[targetIndex, withKeysChanged(current.content.parts[targetIndex], { thoughtSignature: nextPart.thoughtSignature })]])),
    ),
    next: withParts(
      next,
      withIndexesChanged(next.content.parts, new Map([[nextIndex, withKeysChanged(nextPart, { thoughtSignature: undefined })]])),
    ),
  };
};

/** What survives a relocation: a Part it emptied is dropped, and a Part it never touched stays
 *  whatever it was. Membership is by position rather than by object, because the Parts handed
 *  in here have already been rebuilt. */
const keptAfterRelocation = (
  parts: readonly GeminiGenerateContentPart[],
  relocated: ReadonlySet<number>,
): readonly GeminiGenerateContentPart[] => {
  const kept = parts.filter((part, index) => !relocated.has(index) || hasPartContent(part) || part.thoughtSignature !== undefined);
  return kept.length === parts.length ? parts : kept;
};

const hasPartContent = (part: GeminiGenerateContentPart): boolean => {
  const { text, thought: _thought, thoughtSignature: _signature, ...data } = part;
  return (typeof text === 'string' && text.length > 0) || Object.keys(data).length > 0;
};

const sameLogicalElement = (left: GeminiGenerateContentPart, right: GeminiGenerateContentPart): boolean => {
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

const logicalElementGroups = (parts: readonly GeminiGenerateContentPart[]): number[][] => {
  const groups: number[][] = [];
  let indexes: number[] = [];
  let previousContent: GeminiGenerateContentPart | undefined;
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

const firstElementIndexes = (parts: readonly GeminiGenerateContentPart[]): number[] =>
  logicalElementGroups(parts).find(indexes => indexes.some(index => hasPartContent(parts[index]))) ?? [];

const firstContentIndexOfLastElement = (parts: readonly GeminiGenerateContentPart[]): number | undefined =>
  logicalElementGroups(parts)
    .findLast(indexes => indexes.some(index => hasPartContent(parts[index])))
    ?.find(index => hasPartContent(parts[index]));

const firstContentPart = (parts: readonly GeminiGenerateContentPart[]): GeminiGenerateContentPart | undefined =>
  parts.find(hasPartContent);

/** Everything an event carries beside its candidates, folded from the two into one — the later
 *  event's word wins where both have one. The result replaces `target`'s own metadata rather
 *  than adding to it, so a field neither event set is absent rather than stale. */
const mergedEventMetadata = (
  earlier: GeminiGenerateContentResult,
  later: GeminiGenerateContentResult,
  target: GeminiGenerateContentResult,
): GeminiGenerateContentResult => {
  const extras: Record<string, unknown> = {};
  captureExtras(earlier as unknown as Record<string, unknown>, GEMINI_GENERATE_CONTENT_RESULT_KEYS, extras);
  captureExtras(later as unknown as Record<string, unknown>, GEMINI_GENERATE_CONTENT_RESULT_KEYS, extras);
  const usageMetadata = later.usageMetadata ?? earlier.usageMetadata;
  const modelVersion = later.modelVersion ?? earlier.modelVersion;
  const responseId = later.responseId ?? earlier.responseId;
  return {
    ...(target.candidates !== undefined ? { candidates: target.candidates } : {}),
    ...(usageMetadata !== undefined ? { usageMetadata } : {}),
    ...(modelVersion !== undefined ? { modelVersion } : {}),
    ...(responseId !== undefined ? { responseId } : {}),
    ...extras,
  } as GeminiGenerateContentResult;
};

/** The candidates alone. What the event was carrying beside them has moved to its neighbour. */
const withoutEventMetadata = (event: GeminiGenerateContentResult): GeminiGenerateContentResult =>
  (event.candidates !== undefined ? { candidates: event.candidates } : {}) as GeminiGenerateContentResult;

/** The same fold one level down, over a candidate's non-standard keys. */
const mergedCandidateExtras = (
  earlier: GeminiGenerateContentCandidate,
  later: GeminiGenerateContentCandidate,
  target: GeminiGenerateContentCandidate,
): GeminiGenerateContentCandidate => {
  const extras: Record<string, unknown> = {};
  captureExtras(earlier as unknown as Record<string, unknown>, GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, extras);
  captureExtras(later as unknown as Record<string, unknown>, GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, extras);
  const known = Object.fromEntries(
    Object.entries(target).filter(([key]) => GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS.has(key as keyof GeminiGenerateContentCandidate)),
  );
  return { ...known, ...extras } as GeminiGenerateContentCandidate;
};

/** `next` had everything taken out of it, so what it was saying about the turn is said by
 *  `current` instead. */
const withCandidateMetadataFrom = (
  current: GeminiGenerateContentCandidate,
  next: GeminiGenerateContentCandidate,
): GeminiGenerateContentCandidate => {
  const merged = mergedCandidateExtras(current, next, current);
  return withKeysChanged(merged, {
    ...(next.content.role !== undefined ? { content: { ...merged.content, role: next.content.role } } : {}),
    ...(next.finishReason !== undefined ? { finishReason: next.finishReason } : {}),
  });
};

/** The same, in the other direction: `current` was emptied into `next`. */
const withForwardedCandidateMetadata = (
  current: GeminiGenerateContentCandidate,
  next: GeminiGenerateContentCandidate,
): GeminiGenerateContentCandidate => {
  const merged = mergedCandidateExtras(current, next, next);
  return next.content.role === undefined && current.content.role !== undefined
    ? withKeysChanged(merged, { content: { ...merged.content, role: current.content.role } })
    : merged;
};
