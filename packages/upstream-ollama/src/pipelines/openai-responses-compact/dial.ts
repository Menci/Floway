import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeJson, decodeResult, formatOpenAIError } from '../response.ts';
import { decodeOpenAIResponsesCompactionResult, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';

export const openaiResponsesCompact = defineStage({
  name: 'ollama.openaiResponsesCompact.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'openaiResponsesCompact'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'openaiResponsesCompact'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const body = { ...toCompactPayloadShape(facts.openaiResponsesCompact), model };
    const request = dialJson(http, upstream, OLLAMA_INFERENCE_PATHS.openaiResponsesCompact, body);
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeResult(answer, scope, formatOpenAIError, bytes => decodeJson(bytes, decodeOpenAIResponsesCompactionResult));
    return { ...response, openaiResponsesCompact: outcome };
  },
});
