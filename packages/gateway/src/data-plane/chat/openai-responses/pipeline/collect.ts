import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { collectChatStream, type ChatCollectionError } from '../../pipeline/collect.ts';
import { defineDeliveryStage } from '../../pipeline/delivery.ts';
import { openAIResponsesFailureEvents, openAIResponsesStreamErrorPayload } from '../../pipeline/stream-error.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import { OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError, type ProtocolStreamError } from '@floway-dev/upstream';

// https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94
const errorHttpStatus = new Map([
  ['invalid_request_error', 400],
  ['invalid_prompt', 400],
  ['authentication_error', 401],
  ['invalid_api_key', 401],
  ['permission_error', 403],
  ['not_found_error', 404],
  ['conflict_error', 409],
  ['unprocessable_entity_error', 422],
  ['rate_limit_error', 429],
  ['rate_limit_exceeded', 429],
  ['insufficient_quota', 429],
  ['server_error', 500],
  ['internal_error', 500],
]);

const failure = (error: ProtocolStreamError): ChatCollectionError => {
  const { notification, failed } = openAIResponsesFailureEvents(error);
  if (notification !== undefined) {
    const payload = openAIResponsesStreamErrorPayload(notification);
    const details = isJsonObject(payload.provider_specific_fields) ? payload.provider_specific_fields : undefined;
    const status = [payload.code, payload.type, details?.code, details?.type]
      .flatMap(value => typeof value === 'string' ? errorHttpStatus.get(value) ?? [] : [])[0] ?? 502;
    const { sequence_number: _sequenceNumber, ...body } = notification;
    return { status, outcome: { kind: 'error', source: 'upstream', error: body } };
  }
  if (failed !== undefined) {
    return { status: 502, outcome: { kind: 'error', source: 'upstream', error: { error: failed.response.error } } };
  }
  return {
    status: error.kind === 'abort' ? 499 : 502,
    outcome: {
      kind: 'error', source: error.kind === 'abort' ? 'local' : 'upstream', error: openaiInternalErrorPayload(toInternalDebugError(error.cause)),
    },
  };
};

export const collectOpenAIResponses = defineDeliveryStage({
  name: 'openaiResponses.collect',
  through: {
    request: { needs: ['delivery'], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiResponses'], provides: ['http', 'openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const answer = await scope.next(facts);
    const { openaiResponses } = answer;
    if (facts.delivery.stream || openaiResponses.kind !== 'stream') return answer;
    let response: OpenAIResponsesResultEx | undefined;
    const collected = await collectChatStream('OpenAI Responses', answer.http, openaiResponses.stream, scope, {
      accept(event) {
        if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response;
      },
      finish() {
        return response === undefined
          ? failure({ kind: 'protocol', cause: new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE) })
          : { kind: 'result', result: response };
      },
    }, failure);
    return { ...answer, http: collected.http, openaiResponses: collected.outcome };
  },
});
