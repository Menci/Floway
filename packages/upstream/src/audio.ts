// Buffered multipart carrier for OpenAI-compatible audio transcription.
// Entries stay ordered and may repeat, matching FormData semantics. File
// objects retain their bytes, filename, media type, and lastModified metadata;
// providers rebuild a fresh FormData for every candidate so retries never
// reuse a consumed request body.

export interface OpenAIAudioTranscriptionFormEntry {
  readonly name: string;
  readonly value: string | File;
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
      form.append(entry.name, entry.value, entry.value.name);
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
