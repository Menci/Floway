import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIAudioTranscriptionUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, parseAzureStreamOrResult } from '../http.ts';
import { getHeader, type HttpHeaders } from '@floway-dev/http';
import { decodeOpenAIAudioTranscriptionsResult, decodeOpenAIAudioTranscriptionsStream } from '@floway-dev/protocols/openai-audio';
import { httpTerminal, serializeOpenAIAudioTranscriptionsBody } from '@floway-dev/upstream';

const decodeResult = (bytes: Uint8Array, http: { headers: HttpHeaders }) => {
  const contentType = getHeader(http.headers, 'content-type');
  return decodeOpenAIAudioTranscriptionsResult(bytes, typeof contentType === 'string' ? contentType : undefined);
};

const dial = defineStage({
  name: 'azure.openaiAudioTranscriptions.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiAudioTranscriptions'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiAudioTranscriptions'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureOpenAIAudioTranscriptionUrl(endpoint, facts.model.upstreamModelId);
    const body = await serializeOpenAIAudioTranscriptionsBody(facts.openaiAudioTranscriptions, { type: 'omit' });
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureStreamOrResult(answer.http, failure, scope, decodeOpenAIAudioTranscriptionsStream, decodeResult);
    return { ...answer, http: parsed.http, openaiAudioTranscriptions: parsed.outcome };
  },
});

export const azureOpenAIAudioTranscriptionsPipeline = compose('azure.openaiAudioTranscriptions', {
  entry: ['http', 'upstream', 'model', 'openaiAudioTranscriptions'],
  exit: ['http', 'openaiAudioTranscriptions'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
