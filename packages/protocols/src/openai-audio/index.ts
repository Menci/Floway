import type { OpenAISseWireEvent } from '../common/decode-sse-events.ts';
import type { MultipartFile } from '../common/multipart.ts';

export interface OpenAIAudioTranscriptionsPayload {
  readonly entries: readonly { readonly name: string; readonly value: string | MultipartFile }[];
}

// https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
export interface OpenAIAudioSpeechPayload {
  model: string;
  input: string;
  voice: string | { id: string };
  instructions?: string;
  response_format?: string;
  speed?: number;
  stream_format?: string;
  [key: string]: unknown;
}

export interface OpenAIAudioSpeechStreamEvent {
  type?: string;
  [key: string]: unknown;
}

// OpenAI-compatible audio transcription stream terminal. The wire remains open
// so provider additions pass through unchanged while the gateway observes only
// the terminal event it needs.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L61780-L61924

export interface OpenAIAudioTranscriptionStreamEvent {
  type: string;
  [key: string]: unknown;
}

export type OpenAIAudioTranscriptionStreamItem = OpenAISseWireEvent<OpenAIAudioTranscriptionStreamEvent>;

export interface OpenAIAudioTranscriptionDoneEvent extends OpenAIAudioTranscriptionStreamEvent {
  type: 'transcript.text.done';
  text: string;
}

export const isOpenAIAudioTranscriptionDoneEvent = (event: unknown): event is OpenAIAudioTranscriptionDoneEvent =>
  typeof event === 'object'
  && event !== null
  && (event as { type?: unknown }).type === 'transcript.text.done'
  && typeof (event as { text?: unknown }).text === 'string';

export { decodeOpenAIAudioSpeechStream, decodeOpenAIAudioTranscriptionsStream } from './stream.ts';
export { decodeOpenAIAudioTranscriptionsResult } from './transcriptions-result.ts';
