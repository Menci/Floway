import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeJson, decodeResult, decodeStream, formatOpenAIError } from '../response.ts';
import { decodeOpenAICompletionsResult, decodeOpenAICompletionsStream } from '@floway-dev/protocols/openai-completions';

export const openaiCompletions = defineStage({
  name: 'ollama.openaiCompletions.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'openaiCompletions'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'openaiCompletions'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const request = dialJson(http, upstream, OLLAMA_INFERENCE_PATHS.openaiCompletions, { ...facts.openaiCompletions, model });
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = facts.openaiCompletions.stream === true
      ? await decodeStream(answer, scope, formatOpenAIError, decodeOpenAICompletionsStream)
      : await decodeResult(answer, scope, formatOpenAIError, bytes => decodeJson(bytes, decodeOpenAICompletionsResult));
    return { ...response, openaiCompletions: outcome };
  },
});
