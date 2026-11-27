import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialRequest } from '../request.ts';
import { BODY_LIMITS, decodeAnswer, ERROR_BODY_LIMIT, formatOpenAIError } from '../response.ts';
import { getHeader } from '@floway-dev/http';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { decodeOpenAIAudioTranscriptionsResult, decodeOpenAIAudioTranscriptionsStream } from '@floway-dev/protocols/openai-audio';
import { parseUpstreamResult, parseUpstreamStream, serializeOpenAIAudioTranscriptionsBody, type UpstreamResponseFacts } from '@floway-dev/upstream';

export const openaiAudioTranscriptions = defineStage({
  name: 'ollama.openaiAudioTranscriptions.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'openaiAudioTranscriptions'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'openaiAudioTranscriptions'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const { body, contentType } = await serializeOpenAIAudioTranscriptionsBody(facts.openaiAudioTranscriptions, { type: 'replace', value: model });
    const request = dialRequest(http, upstream, OLLAMA_INFERENCE_PATHS.openaiAudioTranscriptions, body, contentType);
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeAnswer<UpstreamResponseFacts['openaiAudioTranscriptions']>(answer, formatOpenAIError, response => {
      const mediaType = getHeader(response.headers, 'content-type');
      if (typeof mediaType === 'string' && isEventStreamMediaType(mediaType)) {
        return parseUpstreamStream(response, scope, decodeOpenAIAudioTranscriptionsStream, formatOpenAIError, ERROR_BODY_LIMIT);
      }
      return parseUpstreamResult(response, scope, bytes => decodeOpenAIAudioTranscriptionsResult(bytes, typeof mediaType === 'string' ? mediaType : undefined), formatOpenAIError, BODY_LIMITS);
    });
    return { ...response, openaiAudioTranscriptions: outcome };
  },
});
