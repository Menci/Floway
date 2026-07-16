import type { GeminiErrorResponse, GeminiStreamEvent } from './index.ts';
import { reassembleGeminiEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';

export const GEMINI_MISSING_TERMINAL_MESSAGE = 'Gemini stream ended without a terminal event.';

export const isGeminiErrorEvent = (event: GeminiStreamEvent): event is GeminiErrorResponse => 'error' in event;

const isGeminiFinishedEvent = (event: GeminiStreamEvent): boolean => 'candidates' in event && event.candidates?.some(candidate => candidate.finishReason !== undefined) === true;

export const isGeminiTerminalEvent = (event: GeminiStreamEvent): boolean => isGeminiErrorEvent(event) || isGeminiFinishedEvent(event);

const geminiEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>): AsyncGenerator<GeminiStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;

    yield frame.event;
    if (isGeminiTerminalEvent(frame.event)) return;
  }

  throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
};

export const collectGeminiProtocolEventsToResult = async (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>) =>
  await reassembleGeminiEvents(geminiEventsUntilTerminal(frames));
