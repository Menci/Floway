import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeStream, formatAnthropicError } from '../response.ts';
import { decodeAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';

export const anthropicMessages = defineStage({
  name: 'ollama.anthropicMessages.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'anthropicMessages'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'anthropicMessages'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const request = dialJson(http, upstream, OLLAMA_INFERENCE_PATHS.anthropicMessages, { ...facts.anthropicMessages, model, stream: true }, true);
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeStream(answer, scope, formatAnthropicError, decodeAnthropicMessagesStream);
    return { ...response, anthropicMessages: outcome };
  },
});
