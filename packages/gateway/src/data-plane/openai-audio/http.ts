import { measureOpenAIAudioTranscriptionUsage } from './usage.ts';
import { createGatewayHttpHandler } from '../pipeline/host.ts';
import { createNonChatPipeline, forwardHttp, header, isUploadError, measured, type ParsedOperation, requestBytes, scalarHttpAttempt, transportHttpAttempt } from '../pipeline/non-chat.ts';
import { observeSse } from '../pipeline/observe-sse.ts';
import { openaiAudioTranscriptionsProviderTargets } from '../providers/upstreams.ts';
import { isOpenAIErrorPayload } from '../shared/openai-error-payload.ts';
import { serializeSseFrame } from '../shared/sse.ts';
import { requestOnlyUsageMeasurement } from '../shared/telemetry/usage.ts';
import type { HttpRequestFacts } from '@floway-dev/http';
import { Bytes } from '@floway-dev/pipeline';
import { isEventStreamMediaType, isJsonMediaType, isMultipartFormDataMediaType, parseSSEStream, UpstreamStreamProtocolError } from '@floway-dev/protocols/common';
import { isOpenAIAudioTranscriptionDoneEvent } from '@floway-dev/protocols/openai-audio';
import { type OpenAIAudioTranscriptionFormEntry, type OpenAIAudioTranscriptionRequest, readHttpBody } from '@floway-dev/provider';

// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040
const parseAudio = async (http: HttpRequestFacts): Promise<ParsedOperation<OpenAIAudioTranscriptionRequest>> => {
  if (isUploadError(http.body)) return { error: http.body.error.message };
  const contentType = header(http.headers, 'content-type');
  if (!isMultipartFormDataMediaType(contentType)) {
    return { error: 'OpenAI Audio Transcriptions request body must use multipart/form-data.' };
  }
  const bytes = requestBytes(http);
  let form: FormData;
  try {
    form = await new Response(bytes.toUint8Array() as Uint8Array<ArrayBuffer>, { headers: { 'content-type': contentType } }).formData();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return { error: 'OpenAI Audio Transcriptions request body must be valid multipart/form-data.' };
  }

  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return { error: 'OpenAI Audio Transcriptions request body must include a model field.' };
  }
  const files = form.getAll('file');
  if (files.length === 0 || files.some(file => !(file instanceof File))) {
    return { error: 'OpenAI Audio Transcriptions request body must include a file upload.' };
  }

  const entries: OpenAIAudioTranscriptionFormEntry[] = [];
  for (const [name, value] of form.entries()) {
    entries.push(typeof value === 'string' ? { kind: 'text', name, value } : {
      kind: 'file', name,
      bytes: Bytes.adopt(new Uint8Array(await value.arrayBuffer())),
      filename: value.name, contentType: value.type,
    });
  }
  return { model, payload: { entries } };
};

const sourceApi = '/audio/transcriptions';
const ingress = createNonChatPipeline({
  name: 'openai-audio-transcriptions',
  sourceApi,
  operation: 'audio_transcription',
  kind: 'transcription',
  parse: parseAudio,
  outcomeKey: 'response.openaiAudioTranscriptions',
  targets: openaiAudioTranscriptionsProviderTargets,
  select: candidates => candidates.filter(candidate => candidate.endpoints.openaiAudioTranscriptions !== undefined),
  respond: async (response, _request, identity, scope) => {
    const http = response['response.http'];
    const forwarded = forwardHttp(http, null);
    let measurement = requestOnlyUsageMeasurement();
    const contentType = header(http.headers, 'content-type');
    if (isEventStreamMediaType(contentType)) {
      return await observeSse({ ...http, status: 200, statusText: '' }, identity, scope, {
        frames: (body, signal) => parseSSEStream(body, { signal }),
        encode: frame => {
          let event: unknown;
          try {
            event = JSON.parse(frame.data);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            throw new UpstreamStreamProtocolError(`Malformed upstream ${sourceApi} SSE JSON: ${frame.data}`, { cause: error });
          }
          const wire = serializeSseFrame(frame);
          if (isOpenAIErrorPayload(event)) return { wire, end: 'protocol-error' };
          if (!isOpenAIAudioTranscriptionDoneEvent(event)) return { wire };
          measurement = measureOpenAIAudioTranscriptionUsage(event, sourceApi);
          return { wire, end: 'completed' };
        },
        eofMessage: 'OpenAI Transcriptions stream ended without a transcript.text.done event.',
        usage: () => measured(measurement),
      });
    }

    if (!isJsonMediaType(contentType)) return scalarHttpAttempt(scope, forwarded, identity);
    const result = await readHttpBody(http.body);
    if (!result.ok) return transportHttpAttempt(scope, forwarded, identity, result.error);
    let body: unknown;
    try {
      body = JSON.parse(result.bytes.utf8());
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      scope.log.warn(`Failed to parse 2xx upstream body for ${sourceApi}; usage row will be request-only`, { message: error.message });
    }
    if (body !== undefined) measurement = measureOpenAIAudioTranscriptionUsage(body, sourceApi);
    return scalarHttpAttempt(scope, { ...forwarded, body: http.body === null ? null : result.bytes }, identity, measured(measurement));
  },
});

export const openaiAudioTranscriptions = createGatewayHttpHandler(ingress, { errorStatus: () => 502 });
