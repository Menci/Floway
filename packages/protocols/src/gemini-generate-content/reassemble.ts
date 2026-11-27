import { GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, GEMINI_GENERATE_CONTENT_RESULT_KEYS } from './field-keys.ts';
import type { GeminiGenerateContentCandidate, GeminiGenerateContentContent, GeminiGenerateContentFinishReason, GeminiGenerateContentPart, GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from './index.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

// Relays (e.g. New-API) and Vertex chunks can emit empty or unspecified finishReason values on non-terminal frames.
// https://github.com/googleapis/googleapis/blob/e7513c828b8db536fa12fc5493d541f323aedf90/google/ai/generativelanguage/v1beta/generative_service.proto#L686-L762
export const isGeminiGenerateContentTerminalFinishReason = (
  reason: GeminiGenerateContentFinishReason | null | undefined,
): reason is GeminiGenerateContentFinishReason =>
  typeof reason === 'string' && reason !== '' && reason !== 'FINISH_REASON_UNSPECIFIED';

const isMergeableTextPart = (part: GeminiGenerateContentPart): boolean =>
  typeof part.text === 'string' && Object.keys(part).every(key => key === 'text' || key === 'thought' && part.thought === false);

export const appendGeminiGenerateContentPart = (parts: GeminiGenerateContentPart[], part: GeminiGenerateContentPart): number => {
  const previous = parts.at(-1);
  if (previous && isMergeableTextPart(previous) && isMergeableTextPart(part)) previous.text = `${previous.text}${part.text}`;
  else parts.push({ ...part });
  return parts.length - 1;
};

type GeminiGenerateContentLogprobsResult = NonNullable<GeminiGenerateContentCandidate['logprobsResult']>;

// Streaming `logprobsResult` chunks carry per-chunk token deltas and partial sums.
// https://github.com/googleapis/python-genai/blob/bbdca2a0d4aff88e4643ee431d7a01bed6e333b6/google/genai/tests/models/test_gc_continuation_token.py#L737-L864
export const mergeGeminiGenerateContentLogprobsResult = (
  earlier: GeminiGenerateContentLogprobsResult | undefined,
  later: GeminiGenerateContentLogprobsResult | undefined,
): GeminiGenerateContentLogprobsResult | undefined => {
  if (earlier === undefined) {
    return later === undefined
      ? undefined
      : {
          ...(later.chosenCandidates === undefined ? {} : { chosenCandidates: [...later.chosenCandidates] }),
          ...(later.topCandidates === undefined ? {} : { topCandidates: [...later.topCandidates] }),
          ...(later.logProbabilitySum === undefined ? {} : { logProbabilitySum: later.logProbabilitySum }),
        };
  }
  if (later === undefined) return earlier;
  return {
    ...(earlier.chosenCandidates === undefined && later.chosenCandidates === undefined
      ? {}
      : { chosenCandidates: [...(earlier.chosenCandidates ?? []), ...(later.chosenCandidates ?? [])] }),
    ...(earlier.topCandidates === undefined && later.topCandidates === undefined
      ? {}
      : { topCandidates: [...(earlier.topCandidates ?? []), ...(later.topCandidates ?? [])] }),
    ...(earlier.logProbabilitySum === undefined && later.logProbabilitySum === undefined
      ? {}
      : { logProbabilitySum: (earlier.logProbabilitySum ?? 0) + (later.logProbabilitySum ?? 0) }),
  };
};

interface CandidateAccumulator {
  candidate: GeminiGenerateContentCandidate;
  content?: GeminiGenerateContentContent & { parts: GeminiGenerateContentPart[] };
  extras: Record<string, unknown>;
}

const finalizeCandidate = (state: CandidateAccumulator): GeminiGenerateContentCandidate => Object.assign(state.candidate, state.extras);

export interface GeminiGenerateContentEventAccumulator {
  accept: (event: GeminiGenerateContentStreamEvent) => void;
  candidate: (index: number) => GeminiGenerateContentCandidate | undefined;
  result: () => GeminiGenerateContentResult;
}

export const createGeminiGenerateContentEventAccumulator = (): GeminiGenerateContentEventAccumulator => {
  const candidates = new Map<number, CandidateAccumulator>();
  const resultFields: GeminiGenerateContentResult = {};
  const resultExtras: Record<string, unknown> = {};

  const accept = (event: GeminiGenerateContentStreamEvent): void => {
    if ('error' in event) throw new Error(`${event.error.status}: ${event.error.message}`, { cause: event });
    for (const incoming of event.candidates ?? []) {
      // Protobuf omits an index whose value is zero; finish-only candidates may have no Content.
      // https://github.com/googleapis/googleapis/blob/e09e85d32ca349e1b205514a412817a7692595c6/google/ai/generativelanguage/v1beta/generative_service.proto
      const index = incoming.index ?? 0;
      const state = candidates.get(index) ?? { candidate: { index }, extras: {} };
      candidates.set(index, state);
      if (incoming.content !== undefined) {
        const content = state.content ??= { parts: [] };
        if (incoming.content.role !== undefined) content.role = incoming.content.role;
        for (const part of incoming.content.parts ?? []) appendGeminiGenerateContentPart(content.parts, part);
        state.candidate.content = content;
      }
      const { content: _content, finishReason, logprobsResult, ...fields } = incoming;
      Object.assign(state.candidate, fields);
      const mergedLogprobs = mergeGeminiGenerateContentLogprobsResult(state.candidate.logprobsResult, logprobsResult);
      if (mergedLogprobs !== undefined) state.candidate.logprobsResult = mergedLogprobs;
      if (finishReason !== undefined && (isGeminiGenerateContentTerminalFinishReason(finishReason) || !isGeminiGenerateContentTerminalFinishReason(state.candidate.finishReason))) {
        state.candidate.finishReason = finishReason;
      }
      captureExtras(incoming as unknown as Record<string, unknown>, GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, state.extras);
    }
    const { candidates: _candidates, ...fields } = event;
    Object.assign(resultFields, fields);
    captureExtras(event as unknown as Record<string, unknown>, GEMINI_GENERATE_CONTENT_RESULT_KEYS, resultExtras);
  };

  const candidate = (index: number): GeminiGenerateContentCandidate | undefined => {
    const state = candidates.get(index);
    return state === undefined ? undefined : finalizeCandidate(state);
  };

  const result = (): GeminiGenerateContentResult => {
    const current: GeminiGenerateContentResult = { ...resultFields };
    if (candidates.size > 0) current.candidates = [...candidates.entries()].toSorted(([a], [b]) => a - b).map(([, state]) => finalizeCandidate(state));
    return Object.assign(current, resultExtras);
  };

  return { accept, candidate, result };
};

export async function reassembleGeminiGenerateContentEvents(events: AsyncIterable<GeminiGenerateContentStreamEvent>): Promise<GeminiGenerateContentResult> {
  const accumulator = createGeminiGenerateContentEventAccumulator();
  for await (const event of events) accumulator.accept(event);
  return accumulator.result();
}
