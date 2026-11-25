import { multipartFile, type UploadedFile } from './multipart.ts';

// Repeated entries retain their original order and each attempt serializes a fresh form.
export interface OpenAIAudioTranscriptionFormEntry {
  readonly name: string;
  readonly value: string | UploadedFile;
}

export interface OpenAIAudioTranscriptionRequest {
  readonly entries: readonly OpenAIAudioTranscriptionFormEntry[];
}

type OpenAIAudioTranscriptionModelField =
  | { readonly type: 'replace'; readonly value: string }
  | { readonly type: 'omit' };

const serializeOpenAIAudioTranscriptionRequest = (
  request: OpenAIAudioTranscriptionRequest,
  modelField: OpenAIAudioTranscriptionModelField,
): FormData => {
  const form = new FormData();
  for (const entry of request.entries) {
    if (entry.name === 'model') {
      if (modelField.type === 'replace') form.append(entry.name, modelField.value);
    } else if (typeof entry.value === 'string') {
      form.append(entry.name, entry.value);
    } else {
      form.append(entry.name, multipartFile(entry.value));
    }
  }
  return form;
};

export const serializeModelFieldOpenAIAudioTranscriptionRequest = (
  request: OpenAIAudioTranscriptionRequest,
  model: string,
): FormData => serializeOpenAIAudioTranscriptionRequest(request, { type: 'replace', value: model });

export const serializeModelPathOpenAIAudioTranscriptionRequest = (
  request: OpenAIAudioTranscriptionRequest,
): FormData => serializeOpenAIAudioTranscriptionRequest(request, { type: 'omit' });
