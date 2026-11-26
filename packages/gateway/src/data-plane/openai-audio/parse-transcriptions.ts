import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { getHeader } from '@floway-dev/http';
import { isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { OpenAIAudioTranscriptionPayload } from '@floway-dev/provider';

type PreparedTranscription =
  | { type: 'ok'; payload: OpenAIAudioTranscriptionPayload }
  | { type: 'invalid'; message: string };

export const openaiAudioError = (message: string) => ({ error: { message, type: 'api_error' } });

export const parseOpenAIAudioTranscriptions = defineStage({
  name: 'openaiAudioTranscriptions.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiAudioTranscriptions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const { body, headers } = facts['request.http'];
    const mediaType = getHeader(headers, 'content-type');
    const request = await prepareTranscription(body ?? new Uint8Array(), typeof mediaType === 'string' ? mediaType : undefined);
    if (request.type === 'invalid') {
      return {
        'response.http': jsonResponse(localResponseHead(400), openaiAudioError(request.message)),
        'response.outcome': scope.createDeferred(async () => 'local' as const),
      };
    }
    return await scope.next({ ...facts, 'request.openaiAudioTranscriptions': request.payload });
  },
});

// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040
const prepareTranscription = async (bytes: Uint8Array, contentType: string | undefined): Promise<PreparedTranscription> => {
  if (!isMultipartFormDataMediaType(contentType)) {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must use multipart/form-data.' };
  }
  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must be valid multipart/form-data.' };
  }
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must include a model field.' };
  }
  const files = form.getAll('file');
  if (files.length === 0 || files.some(file => !(file instanceof File))) {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must include a file upload.' };
  }

  const entries = await Promise.all([...form].map(async ([name, value]) => ({
    name,
    value: typeof value === 'string'
      ? value
      : { name: value.name, mediaType: value.type, bytes: new Uint8Array(await value.arrayBuffer()) },
  })));
  return { type: 'ok', payload: { entries } };
};
