import { defineStage } from '../http.ts';
import { contentTypeOf } from './content-type.ts';
import { sendHttpRequest, type HttpResponseSource } from '@floway-dev/http';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { decodeOpenAIAudioTranscriptionsStream, isOpenAIAudioTranscriptionDoneEvent } from '@floway-dev/protocols/openai-audio';

export const openaiAudioTranscriptionsHttp = defineStage({
  name: 'custom.openaiAudioTranscriptions.http',
  request: { needs: ['http', 'upstream'] },
  return: { provides: ['http', 'http.error?', 'custom.openaiAudioTranscriptions.stream?'] },
  async execute({ http, upstream }, scope) {
    const { body, ...request } = http;
    if (!(body instanceof Uint8Array)) throw new TypeError('Custom Audio Transcriptions requires a serialized multipart request');
    const sent = await sendHttpRequest(scope.services.fetcher(upstream.id), { ...request, body }, scope.signal);
    if (!sent.ok) return { http: null, 'http.error': sent.error };

    const { body: source, ...head } = sent.value;
    if (source !== null && head.status >= 200 && head.status < 300 && isEventStreamMediaType(contentTypeOf(head))) {
      return {
        http: { ...head, body: null },
        'custom.openaiAudioTranscriptions.stream': { kind: 'stream', stream: scope.createStream(() => decodeTranscription(source)) },
      };
    }
    return { http: { ...head, body: source === null ? null : scope.createStream(() => source) } };
  },
});

// Some compatible servers keep the connection open after transcript.text.done.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L61780-L61924
const decodeTranscription = async function* (source: NonNullable<HttpResponseSource['body']>) {
  try {
    for await (const item of decodeOpenAIAudioTranscriptionsStream(source)) {
      yield item;
      if (!item.ok || isOpenAIAudioTranscriptionDoneEvent(item.value.data)) return;
    }
  } finally {
    await source.return();
  }
};
