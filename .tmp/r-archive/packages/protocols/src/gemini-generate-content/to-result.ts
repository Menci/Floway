import type { GeminiGenerateContentErrorResponse, GeminiGenerateContentStreamEvent } from './index.ts';
import { reassembleGeminiGenerateContentEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';

export const GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE = 'Gemini generateContent stream ended without a terminal event.';

export const isGeminiGenerateContentErrorEvent = (event: GeminiGenerateContentStreamEvent): event is GeminiGenerateContentErrorResponse => 'error' in event;

export const isGeminiGenerateContentTerminalEvent = (event: GeminiGenerateContentStreamEvent): boolean => isGeminiGenerateContentErrorEvent(event) || ('promptFeedback' in event && event.promptFeedback?.blockReason !== undefined);

export const createGeminiGenerateContentCandidateCompletion = () => {
  const observed = new Set<number>();
  const finished = new Set<number>();
  return {
    observe: (event: GeminiGenerateContentStreamEvent): void => {
      if (!('candidates' in event)) return;
      for (const candidate of event.candidates ?? []) {
        // Candidate indexes are independent, and an absent finish_reason means that
        // candidate has not stopped. A later index may appear before an earlier one finishes.
        // https://github.com/googleapis/googleapis/blob/e7513c828b8db536fa12fc5493d541f323aedf90/google/ai/generativelanguage/v1beta/generative_service.proto#L686-L762
        const index = candidate.index ?? 0;
        observed.add(index);
        if (candidate.finishReason !== undefined) finished.add(index);
      }
    },
    isComplete: (): boolean => observed.size > 0 && [...observed].every(index => finished.has(index)),
  };
};

const geminiGenerateContentEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<GeminiGenerateContentStreamEvent> {
  const completion = createGeminiGenerateContentCandidateCompletion();
  for await (const frame of frames) {
    if (frame.type === 'done') return;

    yield frame.event;
    if (isGeminiGenerateContentTerminalEvent(frame.event)) return;
    completion.observe(frame.event);
  }

  if (!completion.isComplete()) throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
};

export const collectGeminiGenerateContentProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>) =>
  await reassembleGeminiGenerateContentEvents(geminiGenerateContentEventsUntilTerminal(frames));
