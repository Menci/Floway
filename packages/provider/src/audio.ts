// Buffered multipart carrier for OpenAI-compatible audio transcription.
// Entries stay ordered and may repeat, matching FormData semantics. File
// objects retain their bytes, filename, media type, and lastModified metadata;
// providers rebuild a fresh FormData for every candidate so retries never
// reuse a consumed request body.

export type AudioTranscriptionFormEntry =
  | { readonly name: string; readonly value: string }
  | { readonly name: string; readonly value: File };

export interface AudioTranscriptionRequest {
  readonly entries: readonly AudioTranscriptionFormEntry[];
}

export const serializeOpenAIAudioTranscriptionRequest = (
  request: AudioTranscriptionRequest,
  model: string,
): FormData => {
  const form = new FormData();
  for (const entry of request.entries) {
    if (entry.name === 'model') {
      form.append(entry.name, model);
    } else if (typeof entry.value === 'string') {
      form.append(entry.name, entry.value);
    } else {
      form.append(entry.name, entry.value, entry.value.name);
    }
  }
  return form;
};
