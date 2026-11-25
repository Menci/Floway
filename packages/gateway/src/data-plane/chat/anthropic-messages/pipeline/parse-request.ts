import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { appendFailedUpstreams } from '../../../shared/failed-upstreams.ts';
import { prepareJsonModelRequest } from '../../../shared/json-model-request.ts';
import { inputErrorFields } from '../../shared/errors.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { generateAnthropicId, type AnthropicMessagesCountTokensPayload, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { TranslateInputError } from '@floway-dev/translate';

const { defineStage } = gatewayFactSpace<{}>();

const errorBody = (type: 'invalid_request_error' | 'not_found_error', message: string, fields?: Record<string, unknown>) => ({
  type: 'error',
  error: { type, message, ...(fields === undefined ? {} : { provider_specific_fields: fields }) },
  request_id: generateAnthropicId('req'),
});

export const anthropicMessagesInputError = (error: TranslateInputError) =>
  errorBody('invalid_request_error', error.message, inputErrorFields(error));

export const anthropicMessagesLocalError = (status: number, error: unknown) => ({
  'response.http': move(responseHead(status)),
  'response.anthropicMessages': move({ kind: 'error', source: 'local', error } as const),
});

export const anthropicMessagesAffinityUnavailable = (message: string) =>
  anthropicMessagesLocalError(400, errorBody('invalid_request_error', message));

export const anthropicMessagesModelUnavailable = (operation: 'generate' | 'countTokens') => (
  model: string,
  { sawModel, failedUpstreams }: { readonly sawModel: boolean; readonly failedUpstreams: readonly string[] },
) => anthropicMessagesLocalError(sawModel ? 400 : 404, errorBody(sawModel ? 'invalid_request_error' : 'not_found_error',
  appendFailedUpstreams(sawModel
    ? `Model ${model} does not support the ${operation === 'countTokens' ? '/messages/count_tokens' : '/messages'} endpoint.`
    : `Model ${model} is not available on any configured upstream.`, failedUpstreams)));

const invalidRequest = (error: unknown) => ({ 'response.http': move(jsonResponseBody(responseHead(400), error)) });

export const parseAnthropicMessages = (operation: 'generate' | 'countTokens') => defineStage({
  name: operation === 'generate' ? 'anthropicMessages.parse-request' : 'anthropicMessagesCountTokens.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.anthropicMessages', 'request.delivery', 'serve.model'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return invalidRequest(errorBody('invalid_request_error', 'Anthropic Messages request body must be valid JSON.'));

    const request = prepareJsonModelRequest(raw.value, 'Anthropic Messages');
    if (request.type === 'invalid') return invalidRequest(errorBody('invalid_request_error', request.message));
    const { body, model } = request;
    const betaField = Object.hasOwn(body, 'anthropic_beta') ? 'anthropic_beta' : Object.hasOwn(body, 'betas') ? 'betas' : undefined;
    if (betaField !== undefined) return invalidRequest({
      error: {
        message: `${betaField} in the Anthropic Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param: betaField,
      },
    });
    if (!Array.isArray(body.messages)) return invalidRequest(errorBody('invalid_request_error', 'Anthropic Messages request body must include a messages array.'));

    return await scope.next({
      ...facts,
      'request.anthropicMessages': move(body as unknown as AnthropicMessagesPayload | AnthropicMessagesCountTokensPayload),
      'request.delivery': move(operation === 'generate'
        ? { kind: 'anthropicMessages', stream: body.stream === true } as const
        : { kind: 'json' } as const),
      'serve.model': model,
    });
  },
});
