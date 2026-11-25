import { openAIResponsesInputErrorBody } from './error.ts';
import { openAIResponsesFactSpace, type OpenAIResponsesAction } from './facts.ts';
import type { OpenAIResponsesServices } from './services.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { canonicalizeOpenAIResponsesPayload, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/provider';

const { defineStage } = openAIResponsesFactSpace<Pick<OpenAIResponsesServices, 'requestStartedAt'>>();

export const openAIResponsesRequestFacts = (
  payload: CanonicalOpenAIResponsesPayload,
  action: OpenAIResponsesAction,
  requestStartedAt: number,
) => ({
  'request.openaiResponses': move(payload),
  'request.openaiResponsesAction': action,
  'request.delivery': move({
    kind: 'openaiResponses',
    stream: action === 'generate' && payload.stream === true,
    createdAt: Math.floor(requestStartedAt / 1000),
  } as const),
  'serve.model': payload.model,
});

export const parseOpenAIResponsesRequest = (action: OpenAIResponsesAction) => defineStage({
  name: 'openaiResponses.parse-request',
  through: {
    request: {
      needs: ['request.http'],
      provides: ['request.http', 'request.openaiResponses', 'request.openaiResponsesAction', 'request.delivery', 'serve.model'],
      consumes: [],
    },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const request = facts['request.http'];
    const raw = await readHttpBody(request.body);
    if (!raw.ok) return requestReadError(raw.error.cause);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(raw.value));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return requestReadError(error);
    }

    const payload = canonicalizeOpenAIResponsesPayload(value);
    if ('error' in payload) return invalidRequest(payload.error);
    return await scope.next({
      ...facts,
      'request.http': move({ ...request, body: null }),
      ...openAIResponsesRequestFacts(payload, action, scope.services.requestStartedAt),
    });
  },
});

const invalidRequest = (error: Parameters<typeof openAIResponsesInputErrorBody>[0]) => ({
  'response.http': move(jsonResponseBody(responseHead(400), openAIResponsesInputErrorBody(error))),
});

const requestReadError = (error: unknown) => ({
  'response.http': move(jsonResponseBody(responseHead(502), openaiInternalErrorPayload(toInternalDebugError(error)))),
});
