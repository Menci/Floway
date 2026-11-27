import { defineStage } from './facts.ts';
import { jsonResponse, localHead } from '../shared/http.ts';
import type { AnthropicMessagesCountTokensPayload } from '@floway-dev/protocols/anthropic-messages';
import { isJsonObject } from '@floway-dev/protocols/common';
import { internalDebugErrorFields, parseJsonBody, toInternalDebugError } from '@floway-dev/upstream';

export const parseAnthropicMessagesCountTokens = defineStage({
  name: 'anthropicMessagesCountTokens.parse',
  through: {
    request: { needs: ['http', 'serve.startedAt'], provides: ['anthropicMessagesCountTokens', 'requestedModel'], consumes: ['serve.startedAt'] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http'] },
  async execute({ 'serve.startedAt': _startedAt, ...facts }, scope) {
    const invalid = (status: number, error: unknown) => ({ http: jsonResponse(localHead(status), error) });
    const body = facts.http.body;
    const parsed = body instanceof Uint8Array ? parseJsonBody(body) : undefined;
    if (!parsed?.ok || !isJsonObject(parsed.value)) {
      const error = parsed && !parsed.ok ? parsed.error : new TypeError('Expected an Anthropic Messages count_tokens request object');
      return invalid(502, {
        type: 'error',
        error: { type: 'api_error', message: error.message, ...internalDebugErrorFields(toInternalDebugError(error)) },
      });
    }

    const { value } = parsed;
    const beta = ['anthropic_beta', 'betas'].find(key => Object.hasOwn(value, key));
    if (beta !== undefined) {
      return invalid(400, {
        error: {
          message: `${beta} in the Anthropic Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
          type: 'invalid_request_error',
          param: beta,
        },
      });
    }
    const { model, messages, max_tokens: _maxTokens, stream: _stream, ...parameters } = value;
    if (typeof model !== 'string' || model.length === 0 || !Array.isArray(messages)) {
      return invalid(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Anthropic Messages count_tokens requires a model and messages.' },
      });
    }
    const payload = { ...parameters, model, messages } as AnthropicMessagesCountTokensPayload;
    scope.services.dump?.requestedModel(model);
    return await scope.next({ ...facts, anthropicMessagesCountTokens: payload, requestedModel: model });
  },
});
