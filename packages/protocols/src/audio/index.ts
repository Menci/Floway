// OpenAI-compatible audio transcription stream terminal. The wire remains open
// so provider additions pass through unchanged while the gateway observes only
// the terminal event it needs.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L61780-L61924

export interface AudioTranscriptionStreamEvent {
  type: string;
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
