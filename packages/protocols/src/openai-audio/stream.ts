import { isOpenAIAudioTranscriptionDoneEvent, type OpenAIAudioTranscriptionStreamEvent } from './index.ts';
import { isOpenAIErrorPayload } from '../common/openai-error.ts';
import { parseTargetStreamFrames } from '../common/parse-events.ts';
import { parseSSEStream } from '../common/parse-sse.ts';
import { doneFrame, eventFrame, type DoneFrame, type EventFrame, type SseErrorFrame, type SseReadableFrame } from '../common/sse.ts';

type ParsedOpenAIAudioTranscriptionFrame =
  | (EventFrame<OpenAIAudioTranscriptionStreamEvent> & { readonly frame: SseReadableFrame })
  | DoneFrame
  | (SseErrorFrame & { readonly frame?: SseReadableFrame });

export const parseOpenAIAudioTranscriptionStream = (
  body: ReadableStream<Uint8Array>,
  options: { signal?: AbortSignal | undefined } = {},
): AsyncGenerator<ParsedOpenAIAudioTranscriptionFrame> => (async function* () {
  for await (const frame of parseTargetStreamFrames<OpenAIAudioTranscriptionStreamEvent>(parseSSEStream(body, options), {
    protocol: 'openaiAudioTranscriptions', onRawFrame: true,
  })) {
    if (frame.type === 'error') {
      yield frame;
      return;
    }
    if (frame.type === 'done') {
      yield { type: 'error', cause: { message: 'OpenAI Transcriptions stream ended without a transcript.text.done event.', cause: '[DONE]' } };
      return;
    }

    const event = frame.data;
    if (isOpenAIErrorPayload(event)) {
      yield { type: 'error', cause: { message: event.error.message, cause: event }, frame: frame.frame };
      return;
    }
    yield { ...eventFrame(event), frame: frame.frame };
    if (isOpenAIAudioTranscriptionDoneEvent(event)) {
      yield doneFrame();
      return;
    }
  }
})();
