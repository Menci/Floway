import { OLLAMA_INFERENCE_PATHS } from '../../fetch.ts';
import { defineStage, HTTP_ANSWER, MODEL_ENTRY } from '../facts.ts';
import { dialJson } from '../request.ts';
import { decodeJson, decodeResult, formatAnthropicError } from '../response.ts';
import { decodeAnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import type { UpstreamResult } from '@floway-dev/upstream';

export const anthropicMessagesCountTokens = defineStage({
  name: 'ollama.anthropicMessagesCountTokens.dial',
  through: {
    request: { needs: [...MODEL_ENTRY, 'anthropicMessagesCountTokens'], provides: ['http'], consumes: [] },
    response: { needs: HTTP_ANSWER, provides: ['http', 'anthropicMessagesCountTokens'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { http, upstream, model: { upstreamModelId: model } } = facts;
    const request = dialJson(http, upstream, OLLAMA_INFERENCE_PATHS.anthropicMessagesCountTokens, { ...facts.anthropicMessagesCountTokens, model }, true);
    const answer = await scope.next({ ...facts, http: request });
    const { outcome, ...response } = await decodeResult<UpstreamResult<'anthropicMessagesCountTokens'>>(answer, scope, formatAnthropicError, (bytes, { status }) => status === 204 || status === 205
      ? { ok: true, value: null }
      : decodeJson(bytes, decodeAnthropicMessagesCountTokensResult));
    return { ...response, anthropicMessagesCountTokens: outcome };
  },
});
