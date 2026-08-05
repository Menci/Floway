import type { GeminiErrorResponse, GeminiStreamEvent } from './index.ts';
import { assertGeminiCandidateIndex } from './candidate-index.ts';
import { reassembleGeminiEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';

export const GEMINI_MISSING_TERMINAL_MESSAGE = 'Gemini stream ended without a terminal event.';

export const isGeminiErrorEvent = (event: GeminiStreamEvent): event is GeminiErrorResponse => 'error' in event;

export const createGeminiTerminalDetector = (): ((event: GeminiStreamEvent) => boolean) => {
  const seenCandidates = new Set<number>();
  const finishedCandidates = new Set<number>();
  return event => {
    if (isGeminiErrorEvent(event)) return true;
    for (const candidate of event.candidates ?? []) {
      assertGeminiCandidateIndex(candidate.index);
      seenCandidates.add(candidate.index);
      if (candidate.finishReason !== undefined) finishedCandidates.add(candidate.index);
    }
    return seenCandidates.size > 0 && seenCandidates.size === finishedCandidates.size;
  };
};

const geminiEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>): AsyncGenerator<GeminiStreamEvent> {
  const isTerminal = createGeminiTerminalDetector();
  for await (const frame of frames) {
    if (frame.type === 'done') return;

    yield frame.event;
    if (isTerminal(frame.event)) return;
  }

  throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
};

export const collectGeminiProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>) =>
  await reassembleGeminiEvents(geminiEventsUntilTerminal(frames));
