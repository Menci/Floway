// The event stream a transcription answers with when the client asked for one. The stream
// stays open: a provider addition rides through untouched while the gateway names only the
// events it acts on. `transcript.text.delta` is the increment, `transcript.text.done` is
// the terminal one and the only place a streamed transcription states its usage.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L61796-L61917

import type { OpenAIAudioTranscriptionUsage } from './transcription.ts';
import { parseOpenAIAudioTranscriptionUsage } from './transcription.ts';

export interface OpenAIAudioTranscriptionStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface OpenAIAudioTranscriptionDoneEvent extends OpenAIAudioTranscriptionStreamEvent {
  type: 'transcript.text.done';
  text: string;
}

export const isOpenAIAudioTranscriptionDoneEvent = (event: unknown): event is OpenAIAudioTranscriptionDoneEvent =>
  typeof event === 'object'
  && event !== null
  && (event as { type?: unknown }).type === 'transcript.text.done'
  && typeof (event as { text?: unknown }).text === 'string';

/** A streamed transcription states its usage once, in the terminal event, in the same shape
 *  a JSON body states it. */
export const parseOpenAIAudioTranscriptionStreamUsage = (
  event: OpenAIAudioTranscriptionDoneEvent,
): OpenAIAudioTranscriptionUsage | undefined => parseOpenAIAudioTranscriptionUsage(event);
