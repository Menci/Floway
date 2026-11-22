import type { MultipartField, MultipartRequestBody } from './request-body.ts';

export type OpenAIAudioTranscriptionFormEntry = MultipartField;

export interface OpenAIAudioTranscriptionRequest {
  readonly entries: readonly OpenAIAudioTranscriptionFormEntry[];
}

export const serializeModelFieldOpenAIAudioTranscriptionRequest = (
  request: OpenAIAudioTranscriptionRequest,
  model: string,
): MultipartRequestBody => ({
  kind: 'multipart',
  parts: request.entries.map(entry => entry.name === 'model' ? { kind: 'text', name: 'model', value: model } : entry),
});

export const serializeModelPathOpenAIAudioTranscriptionRequest = (
  request: OpenAIAudioTranscriptionRequest,
): MultipartRequestBody => ({
  kind: 'multipart',
  parts: request.entries.filter(entry => entry.name !== 'model'),
});
