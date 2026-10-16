import type { GeminiGenerateContentErrorResponse, GeminiGenerateContentStreamEvent } from './index.ts';
import { reassembleGeminiGenerateContentEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';

export const GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE = 'Gemini generateContent stream ended without a terminal event.';

export const isGeminiGenerateContentErrorEvent = (event: GeminiGenerateContentStreamEvent): event is GeminiGenerateContentErrorResponse => 'error' in event;

export const isGeminiGenerateContentCandidateFinishedEvent = (event: GeminiGenerateContentStreamEvent): boolean => 'candidates' in event && event.candidates?.some(candidate => candidate.finishReason !== undefined) === true;

export const isGeminiGenerateContentTerminalEvent = (event: GeminiGenerateContentStreamEvent): boolean => isGeminiGenerateContentErrorEvent(event) || ('promptFeedback' in event && event.promptFeedback?.blockReason !== undefined);

const geminiGenerateContentEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncGenerator<GeminiGenerateContentStreamEvent> {
  let candidateFinished = false;
  for await (const frame of frames) {
    if (frame.type === 'done') return;

    yield frame.event;
    if (isGeminiGenerateContentTerminalEvent(frame.event)) return;
    if (isGeminiGenerateContentCandidateFinishedEvent(frame.event)) candidateFinished = true;
  }

  if (!candidateFinished) throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
};

export const collectGeminiGenerateContentProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>) =>
  await reassembleGeminiGenerateContentEvents(geminiGenerateContentEventsUntilTerminal(frames));
