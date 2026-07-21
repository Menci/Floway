// OpenAI-compatible audio transcription response shapes. The wire remains
// open so provider additions pass through unchanged; named fields cover usage
// extraction and the stream terminal the gateway itself must observe.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36378-L36562
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L61780-L61924

export interface AudioTranscriptionInputTokenDetails {
  text_tokens?: number;
  audio_tokens?: number;
  [key: string]: unknown;
}

export interface AudioTranscriptionTokenUsage {
  type: 'tokens';
  input_tokens: number;
  input_token_details?: AudioTranscriptionInputTokenDetails;
  output_tokens: number;
  total_tokens: number;
  [key: string]: unknown;
}

export interface AudioTranscriptionDurationUsage {
  type: 'duration';
  seconds: number;
  [key: string]: unknown;
}

export type AudioTranscriptionUsage = AudioTranscriptionTokenUsage | AudioTranscriptionDurationUsage;

export interface AudioTranscriptionResponse {
  usage?: AudioTranscriptionUsage;
  [key: string]: unknown;
}

export interface AudioTranscriptionStreamEvent {
  type: string;
  usage?: AudioTranscriptionUsage;
  [key: string]: unknown;
}

export interface AudioTranscriptionDoneEvent extends AudioTranscriptionStreamEvent {
  type: 'transcript.text.done';
  text: string;
}

export const isAudioTranscriptionDoneEvent = (event: unknown): event is AudioTranscriptionDoneEvent =>
  typeof event === 'object'
  && event !== null
  && (event as { type?: unknown }).type === 'transcript.text.done'
  && typeof (event as { text?: unknown }).text === 'string';
