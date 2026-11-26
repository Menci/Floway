import { customOperationPath } from '../../endpoint.ts';
import { customOperation, formBody, openAIError, selectEventStream } from '../dial.ts';
import { decodeOpenAIAudioTranscriptionsStream } from '@floway-dev/protocols/openai-audio';
import { parseHttpResponse, type OpenAIAudioTranscriptionPayload } from '@floway-dev/provider';

const transcriptionForm = ({ entries }: OpenAIAudioTranscriptionPayload, model: string): FormData => {
  const form = new FormData();
  for (const { name, value } of entries) {
    if (name === 'model') {
      form.append(name, model);
    } else if (typeof value === 'string') {
      form.append(name, value);
    } else {
      const bytes = value.bytes.buffer instanceof ArrayBuffer ? value.bytes as Uint8Array<ArrayBuffer> : new Uint8Array(value.bytes);
      form.append(name, new File([bytes], value.name, { type: value.mediaType }));
    }
  }
  return form;
};

export const openaiAudioTranscriptions = customOperation('openaiAudioTranscriptions', {
  parse: parseHttpResponse('openaiAudioTranscriptions', {
    select: (_payload, head) => selectEventStream(head),
    stream: decodeOpenAIAudioTranscriptionsStream,
    result: bytes => ({ ok: true, value: bytes }),
    format: openAIError,
  }),
  prepare: async (payload, model, config) => ({
    path: customOperationPath(config, '/audio/transcriptions'),
    ...await formBody(transcriptionForm(payload, model.upstreamModelId)),
  }),
});
