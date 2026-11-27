import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeStream, formatOpenAIError } from '../response.ts';
import { decodeOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';

export const openaiResponses = defineStage({
  name: 'ollama.openaiResponses.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'openaiResponses'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'openaiResponses'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const request = dialJson(http, upstream, OLLAMA_INFERENCE_PATHS.openaiResponses, { ...facts.openaiResponses, model, stream: true });
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeStream(answer, scope, formatOpenAIError, decodeOpenAIResponsesStream);
    return { ...response, openaiResponses: outcome };
  },
});
