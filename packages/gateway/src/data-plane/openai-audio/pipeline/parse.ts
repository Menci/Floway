import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../pipeline/response.ts';
import { getHeader, readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import { formatOpenAIAudioTranscriptionsError } from '@floway-dev/protocols/openai-audio';
import { readUploadedFile, type OpenAIAudioTranscriptionFormEntry } from '@floway-dev/provider';

const { defineStage } = gatewayFactSpace<{}>();

export const openAIAudioTranscriptionsError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.openaiAudioTranscriptions': move({ kind: 'error', source: 'local', error: formatOpenAIAudioTranscriptionsError(status, message) } as const),
});

const invalid = (message: string) => ({
  'response.http': move(jsonResponseBody(responseHead(400), formatOpenAIAudioTranscriptionsError(400, message))),
});

export const parseOpenAIAudioTranscriptions = defineStage({
  name: 'openaiAudioTranscriptions.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiAudioTranscriptions', 'request.delivery', 'serve.model'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const raw = await readHttpBody(request.body);
    const contentType = getHeader(request.headers, 'content-type');
    if (typeof contentType !== 'string' || !isMultipartFormDataMediaType(contentType)) {
      return invalid('OpenAI Audio Transcriptions request body must use multipart/form-data.');
    }
    if (!raw.ok) return invalid('OpenAI Audio Transcriptions request body must be valid multipart/form-data.');

    let form: FormData;
    try {
      form = await new Response(raw.value as BodyInit, { headers: { 'content-type': contentType } }).formData();
    } catch {
      return invalid('OpenAI Audio Transcriptions request body must be valid multipart/form-data.');
    }
    const model = form.get('model');
    if (typeof model !== 'string' || model.length === 0) {
      return invalid('OpenAI Audio Transcriptions request body must include a model field.');
    }
    const files = form.getAll('file');
    if (files.length === 0 || files.some(file => !(file instanceof File))) {
      return invalid('OpenAI Audio Transcriptions request body must include a file upload.');
    }

    const entries: OpenAIAudioTranscriptionFormEntry[] = [];
    for (const [name, value] of form.entries()) {
      entries.push({ name, value: typeof value === 'string' ? value : await readUploadedFile(value) });
    }
    return await scope.next({
      ...facts,
      'request.delivery': move(form.get('stream') === 'true' ? { kind: 'sse', includeUsage: true } : { kind: 'bytes' }),
      'request.openaiAudioTranscriptions': move({ entries }),
      'serve.model': model,
    });
  },
});
