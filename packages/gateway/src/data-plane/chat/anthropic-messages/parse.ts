import { anthropicMessagesInternalErrorPayload } from './errors.ts';
import { jsonResponse, localResponseHead } from '../../pipeline/encode.ts';
import type { GatewayPipelineFacts } from '../../pipeline/facts.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { isJsonObject } from '@floway-dev/protocols/common';
import { parseJsonBody, toInternalDebugError } from '@floway-dev/provider';

export interface AnthropicMessagesDelivery {
  stream: boolean;
}

const { defineStage } = factSpace<GatewayPipelineFacts & { 'request.delivery': AnthropicMessagesDelivery }, GatewayServices>();

export const anthropicBodyBetaError = (body: object) => {
  const field = Object.hasOwn(body, 'anthropic_beta') ? 'anthropic_beta' : Object.hasOwn(body, 'betas') ? 'betas' : undefined;
  if (field === undefined) return undefined;
  return {
    error: {
      message: `${field} in the Anthropic Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
      type: 'invalid_request_error',
      param: field,
    },
  };
};

export const parseAnthropicMessages = defineStage({
  name: 'anthropicMessages.parse',
  through: {
    request: { needs: ['request.http'], provides: ['request.anthropicMessages', 'request.delivery'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const parsed = parseJsonBody(facts['request.http'].body ?? new Uint8Array());
    if (!parsed.ok || !isJsonObject(parsed.value)) {
      const error = parsed.ok ? new TypeError('Expected an Anthropic Messages request object') : parsed.error;
      return { 'response.http': jsonResponse(localResponseHead(502), anthropicMessagesInternalErrorPayload(toInternalDebugError(error))) };
    }
    const betaError = anthropicBodyBetaError(parsed.value);
    if (betaError !== undefined) return { 'response.http': jsonResponse(localResponseHead(400), betaError) };
    const payload = parsed.value as unknown as AnthropicMessagesPayload;
    return await scope.next({
      ...facts,
      'request.anthropicMessages': payload,
      'request.delivery': { stream: payload.stream === true },
    });
  },
});
