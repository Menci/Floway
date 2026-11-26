import { anthropicMessagesInternalErrorPayload } from '../chat/anthropic-messages/errors.ts';
import { anthropicBodyBetaError } from '../chat/anthropic-messages/parse.ts';
import { jsonResponse, localResponseHead } from '../pipeline/encode.ts';
import { defineStage, type GatewayPipelineFacts } from '../pipeline/facts.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody, toInternalDebugError } from '@floway-dev/provider';

type CountPayload = GatewayPipelineFacts['request.anthropicMessagesCountTokens'];

export const parseAnthropicMessagesCountTokens = defineStage({
  name: 'anthropicMessagesCountTokens.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.anthropicMessagesCountTokens'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const invalid = (status: number, error: unknown) => ({
      'response.http': jsonResponse(localResponseHead(status), error),
      'response.outcome': scope.createDeferred(async () => 'local' as const),
    });
    const parsed = parseJsonBody(facts['request.http'].body ?? new Uint8Array());
    if (!parsed.ok || !isJsonObject(parsed.value)) {
      const error = parsed.ok ? new TypeError('Expected an Anthropic Messages count_tokens request object') : parsed.error;
      return invalid(502, anthropicMessagesInternalErrorPayload(toInternalDebugError(error)));
    }

    const invalidBeta = anthropicBodyBetaError(parsed.value);
    if (invalidBeta !== undefined) return invalid(400, invalidBeta);
    const { model, messages, max_tokens: _maxTokens, stream: _stream, ...parameters } = parsed.value;
    if (typeof model !== 'string' || model.length === 0 || !Array.isArray(messages)) {
      return invalid(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Anthropic Messages count_tokens requires a model and messages.' },
      });
    }
    const payload = { ...parameters, model, messages } as CountPayload;
    return await scope.next({ ...facts, 'request.anthropicMessagesCountTokens': payload });
  },
});
