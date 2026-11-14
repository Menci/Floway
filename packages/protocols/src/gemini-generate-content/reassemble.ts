import { GEMINI_GENERATE_CONTENT_CANDIDATE_KEYS, GEMINI_GENERATE_CONTENT_RESULT_KEYS } from './field-keys.ts';
import type { GeminiGenerateContentCandidate, GeminiGenerateContentContent, GeminiGenerateContentPart, GeminiGenerateContentResult, GeminiGenerateContentStreamEvent } from './index.ts';
import { captureExtras } from '../common/reassemble-extras.ts';

const isMergeableTextPart = (part: GeminiGenerateContentPart): boolean => part.text !== undefined && Object.keys(part).every(key => key === 'text' || key === 'thought' && part.thought === false);
const appendPart = (parts: GeminiGenerateContentPart[], part: GeminiGenerateContentPart): void => {
  const previous = parts.at(-1);
  if (previous && isMergeableTextPart(previous) && isMergeableTextPart(part)) previous.text = `${previous.text}${part.text}`;
  else parts.push({ ...part });
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
        for (const part of incoming.content.parts ?? []) appendPart(content.parts, part);
        state.candidate.content = content;
      }
      const { content: _content, ...fields } = incoming;
      Object.assign(state.candidate, fields);
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
