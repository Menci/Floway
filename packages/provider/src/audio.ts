import type { HttpFormEntry } from '@floway-dev/http/request-content';

export type OpenAIAudioTranscriptionFormEntry = HttpFormEntry;

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
      const file = entry.value;
      form.append(entry.name, new File([file.bytes as Uint8Array<ArrayBuffer>], file.name, { type: file.type, lastModified: file.lastModified }));
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
