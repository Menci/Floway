import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeJson, decodeResult, formatOpenAIError } from '../response.ts';
import { isJsonObject } from '@floway-dev/protocols/common';

const expectObject = (value: unknown) => isJsonObject(value) ? { ok: true, value } as const : { ok: false, error: new Error('Expected a JSON object in Ollama response') } as const;

export const openaiEmbeddings = defineStage({
  name: 'ollama.openaiEmbeddings.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'openaiEmbeddings'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'openaiEmbeddings'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const request = dialJson(http, upstream, OLLAMA_INFERENCE_PATHS.openaiEmbeddings, { ...facts.openaiEmbeddings, model });
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeResult(answer, scope, formatOpenAIError, bytes => decodeJson(bytes, expectObject));
    return { ...response, openaiEmbeddings: outcome };
  },
});
