import { azureOpenAIAudioTranscriptionUrl } from '../../endpoint.ts';
import { azureOperation, formBody, openAIError, selectEventStream } from '../dial.ts';
import { getHeader } from '@floway-dev/http';
import { decodeOpenAIAudioTranscriptionsResult, decodeOpenAIAudioTranscriptionsStream } from '@floway-dev/protocols/openai-audio';
import { parseHttpResponse, type OpenAIAudioTranscriptionPayload } from '@floway-dev/provider';

const transcriptionForm = ({ entries }: OpenAIAudioTranscriptionPayload): FormData => {
  const form = new FormData();
  for (const { name, value } of entries) {
    if (name === 'model') continue;
    if (typeof value === 'string') {
      form.append(name, value);
    } else {
      const bytes = value.bytes.buffer instanceof ArrayBuffer ? value.bytes as Uint8Array<ArrayBuffer> : new Uint8Array(value.bytes);
      form.append(name, new File([bytes], value.name, { type: value.mediaType }));
    }
  }
  return form;
};

export const openaiAudioTranscriptions = azureOperation('openaiAudioTranscriptions', {
  parse: parseHttpResponse('openaiAudioTranscriptions', {
    select: (_payload, head) => selectEventStream(head),
    stream: decodeOpenAIAudioTranscriptionsStream,
    result(bytes, http) {
      const contentType = getHeader(http.headers, 'content-type');
      return decodeOpenAIAudioTranscriptionsResult(bytes, typeof contentType === 'string' ? contentType : undefined);
    },
    format: openAIError,
  }),
  prepare: async (payload, modelId, endpoint) => ({
    url: azureOpenAIAudioTranscriptionUrl(endpoint, modelId),
    ...await formBody(transcriptionForm(payload)),
  }),
});
