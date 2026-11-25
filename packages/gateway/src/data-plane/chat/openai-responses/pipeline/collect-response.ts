import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import { responseHead } from '../../../pipeline/response.ts';
import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { collectChatOutcome } from '../../pipeline/collect.ts';
import { move } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, isOpenAIResponsesErrorEvent, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/provider';

const { defineStage } = openAIResponsesFactSpace<{}>();

export const collectOpenAIResponses = defineStage({
  name: 'openaiResponses.collect-response',
  through: {
    request: { needs: ['request.delivery', 'request.openaiResponsesAction'], provides: [], consumes: [] },
    response: { needs: openAIResponsesExit, provides: openAIResponsesExit, consumes: [] },
  },
  async execute(facts, scope) {
    const call = scope.next(facts);
    const back = await call;
    const outcome = back['response.openaiResponses'];
    const delivery = facts['request.delivery'];
    if (delivery.kind !== 'openaiResponses') throw new TypeError('OpenAI Responses collection requires Responses delivery');
    if (delivery.stream || facts['request.openaiResponsesAction'] === 'compact' || outcome.kind !== 'stream') return back;
    const result = await collectChatOutcome(outcome.stream, { abort: () => { scope.abort(call); } },
      collectOpenAIResponsesProtocolEventsToResult, (_message, cause) => openaiInternalErrorPayload(toInternalDebugError(cause)));
    if (result.kind === 'result') return { ...back, 'response.openaiResponses': move(result) };
    const event = result.cause instanceof Error && isOpenAIResponsesErrorEvent(result.cause.cause) ? result.cause.cause : undefined;
    if (event === undefined) {
      return { ...back, 'response.http': move(responseHead(502)), 'response.openaiResponses': move(result) };
    }

    const { sequence_number: _sequenceNumber, ...error } = event;
    return {
      ...back,
      'response.http': move(responseHead(errorStatus(event))),
      'response.openaiResponses': move({ ...result, error }),
    };
  },
});

// https://github.com/openai/openai-node/blob/b579bcb3e586d22269ffe6fe504653a0e05acbe8/src/core/error.ts#L60-L94
const statuses = new Map([
  ['invalid_request_error', 400], ['invalid_prompt', 400],
  ['authentication_error', 401], ['invalid_api_key', 401],
  ['permission_error', 403], ['not_found_error', 404], ['conflict_error', 409], ['unprocessable_entity_error', 422],
  ['rate_limit_error', 429], ['rate_limit_exceeded', 429], ['insufficient_quota', 429],
  ['server_error', 500], ['internal_error', 500],
]);

const errorStatus = (event: Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>): number => {
  const { type: _type, sequence_number: _sequenceNumber, ...fields } = event;
  const payload: Readonly<Record<string, unknown>> = 'error' in fields && isJsonObject(fields.error) ? fields.error : fields;
  const details = isJsonObject(payload.provider_specific_fields) ? payload.provider_specific_fields : undefined;
  for (const classification of [payload.code, payload.type, details?.code, details?.type]) {
    if (typeof classification !== 'string') continue;
    const status = statuses.get(classification);
    if (status !== undefined) return status;
  }
  return 502;
};
