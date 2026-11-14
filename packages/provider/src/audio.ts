import type { HttpFormEntry } from '@floway-dev/http/request-content';

export type OpenAIAudioTranscriptionFormEntry = HttpFormEntry;

export interface OpenAIAudioTranscriptionRequest {
  readonly entries: readonly OpenAIAudioTranscriptionFormEntry[];
}
