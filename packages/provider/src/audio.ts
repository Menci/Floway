// Buffered multipart carrier for OpenAI-compatible audio transcription.
// Entries stay ordered and may repeat, matching FormData semantics. File
// objects retain their bytes, filename, media type, and lastModified metadata;
// providers rebuild a fresh FormData for every candidate so retries never
// reuse a consumed request body.

export interface AudioTranscriptionFormEntry {
  readonly name: string;
  readonly value: string | File;
}

export interface AudioTranscriptionRequest {
  readonly entries: readonly AudioTranscriptionFormEntry[];
}

type AudioTranscriptionModelField =
  | { readonly type: 'replace'; readonly value: string }
  | { readonly type: 'omit' };

const serializeAudioTranscriptionRequest = (
  request: AudioTranscriptionRequest,
  modelField: AudioTranscriptionModelField,
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

export const serializeOpenAIAudioTranscriptionRequest = (
  request: AudioTranscriptionRequest,
  model: string,
): FormData => serializeAudioTranscriptionRequest(request, { type: 'replace', value: model });

export const serializeModelPathAudioTranscriptionRequest = (
  request: AudioTranscriptionRequest,
): FormData => serializeAudioTranscriptionRequest(request, { type: 'omit' });
