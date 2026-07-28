import { GEMINI_CANDIDATE_KEYS, GEMINI_RESULT_KEYS } from './field-keys.ts';
import type { GeminiCandidate, GeminiPart, GeminiResult, GeminiStreamEvent } from './index.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

const isMergeableTextPart = (part: GeminiPart): boolean =>
  part.text !== undefined
  && part.thought !== true
  && part.thoughtSignature === undefined
  && part.inlineData === undefined
  && part.functionCall === undefined
  && part.functionResponse === undefined
  && part.fileData === undefined
  && part.executableCode === undefined
  && part.codeExecutionResult === undefined;

const appendPart = (parts: GeminiPart[], part: GeminiPart): void => {
  const previous = parts.at(-1);
  if (previous && isMergeableTextPart(previous) && isMergeableTextPart(part)) {
    previous.text = `${previous.text}${part.text}`;
    return;
  }

  parts.push({ ...part });
};

interface GeminiCandidateWithExtras extends GeminiCandidate {
  __extras?: Record<string, unknown>;
}

const mergeCandidate = (candidates: Map<number, GeminiCandidateWithExtras>, incoming: GeminiCandidate): void => {
  const existing = candidates.get(incoming.index);
  if (!existing) {
    const candidate: GeminiCandidateWithExtras = {
      index: incoming.index,
      content: {
        ...(incoming.content.role !== undefined ? { role: incoming.content.role } : {}),
        parts: [],
      },
      ...(incoming.finishReason !== undefined ? { finishReason: incoming.finishReason } : {}),
      ...(incoming.finishMessage !== undefined ? { finishMessage: incoming.finishMessage } : {}),
      ...(incoming.safetyRatings !== undefined ? { safetyRatings: incoming.safetyRatings.map(rating => ({ ...rating })) } : {}),
    };
    for (const part of incoming.content.parts) {
      appendPart(candidate.content.parts, part);
    }
    const extras: Record<string, unknown> = {};
    captureExtras(incoming as unknown as Record<string, unknown>, GEMINI_CANDIDATE_KEYS, extras);
    if (Object.keys(extras).length > 0) candidate.__extras = extras;
    candidates.set(incoming.index, candidate);
    return;
  }

  if (incoming.content.role !== undefined) {
    existing.content.role = incoming.content.role;
  }
  for (const part of incoming.content.parts) {
    appendPart(existing.content.parts, part);
  }
  if (incoming.finishReason !== undefined) {
    existing.finishReason = incoming.finishReason;
  }
  if (incoming.finishMessage !== undefined) existing.finishMessage = incoming.finishMessage;
  if (incoming.safetyRatings !== undefined) existing.safetyRatings = incoming.safetyRatings.map(rating => ({ ...rating }));
  const extras = existing.__extras ?? {};
  captureExtras(incoming as unknown as Record<string, unknown>, GEMINI_CANDIDATE_KEYS, extras);
  if (Object.keys(extras).length > 0) existing.__extras = extras;
};

const finalizeCandidate = (candidate: GeminiCandidateWithExtras): GeminiCandidate => {
  const { __extras: extras, ...rest } = candidate;
  return extras ? ({ ...rest, ...extras } as GeminiCandidate) : (rest as GeminiCandidate);
};

export async function reassembleGeminiEvents(events: AsyncIterable<GeminiStreamEvent>): Promise<GeminiResult> {
  const candidates = new Map<number, GeminiCandidateWithExtras>();
  const result: GeminiResult = {};
  const resultExtras: Record<string, unknown> = {};

  for await (const event of events) {
    if ('error' in event) {
      throw new Error(`${event.error.status}: ${event.error.message}`, { cause: event });
    }

    for (const candidate of event.candidates ?? []) {
      mergeCandidate(candidates, candidate);
    }

    if (event.modelVersion !== undefined) result.modelVersion = event.modelVersion;
    if (event.responseId !== undefined) result.responseId = event.responseId;
    if (event.usageMetadata !== undefined) result.usageMetadata = event.usageMetadata;
    captureExtras(event as unknown as Record<string, unknown>, GEMINI_RESULT_KEYS, resultExtras);
  }

  const mergedCandidates = [...candidates.values()].sort((a, b) => a.index - b.index).map(finalizeCandidate);
  if (mergedCandidates.length > 0) result.candidates = mergedCandidates;

  return Object.keys(resultExtras).length > 0 ? ({ ...result, ...resultExtras } as GeminiResult) : result;
}
