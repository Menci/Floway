import { openAIResponsesLocalError } from './errors.ts';
import { defineOpenAIResponsesStage, type OpenAIResponsesDelivery } from './pipeline-facts.ts';
import { jsonResponse } from '../../pipeline/encode.ts';
import { isJsonObject } from '@floway-dev/protocols/common';
import { canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const decoder = new TextDecoder();

export const parseOpenAIResponsesJson = (bytes: Uint8Array | null, label = 'OpenAI Responses request body'): { value: unknown } | { error: string } => {
  if (bytes === null) return { error: `${label} is required.` };
  try {
    return { value: JSON.parse(decoder.decode(bytes)) as unknown };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { error: `${label} must be valid JSON: ${error.message}` };
  }
};

const openAIResponsesDelivery = (stream: boolean, startedAt: number): OpenAIResponsesDelivery => ({
  stream,
  createdAt: Math.floor(startedAt / 1000),
});

export const parseOpenAIResponses = defineOpenAIResponsesStage({
  name: 'openaiResponses.parse',
  through: {
    request: {
      needs: ['request.http', 'serve.startedAt'],
      provides: ['request.openaiResponses', 'request.delivery'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.outcome'] },
  async execute(facts, scope) {
    const body = parseOpenAIResponsesJson(facts['request.http'].body);
    const payload = 'error' in body ? { error: { message: body.error } } : canonicalizeOpenAIResponsesPayload(body.value);
    if (!('input' in payload)) {
      const { message, param, code } = payload.error;
      const { http, outcome } = openAIResponsesLocalError(400, message, { param: param ?? 'input', code: code ?? null });
      return {
        'response.http': jsonResponse(http, outcome.error),
        'response.outcome': scope.createDeferred(async () => 'local' as const),
      };
    }

    return await scope.next({
      ...facts,
      'request.openaiResponses': payload,
      'request.delivery': openAIResponsesDelivery(payload.stream === true, facts['serve.startedAt']),
    });
  },
});

export const openAIResponsesWebSocketPayload = (message: Record<string, unknown>): Record<string, unknown> => {
  const { type: _type, event_id: _eventId, ...body } = message;
  return isJsonObject(message.response) ? message.response : body;
};

export const parseOpenAIResponsesWebSocket = defineOpenAIResponsesStage({
  name: 'openaiResponses.parse-websocket',
  through: {
    request: {
      needs: ['request.http', 'serve.startedAt', 'request.ws.responseId'],
      provides: ['request.openaiResponses', 'request.delivery'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const body = parseOpenAIResponsesJson(facts['request.http'].body, 'WebSocket message');
    const fail = (message: string, fields: { code?: string; param?: string } = {}) => {
      const { http, outcome } = openAIResponsesLocalError(400, message, { code: 'invalid_request_error', ...fields });
      return { 'response.http': http, 'response.openaiResponses': outcome };
    };
    if ('error' in body) return fail(body.error);
    if (!isJsonObject(body.value) || typeof body.value.type !== 'string') {
      return fail('WebSocket message must be a JSON object with a string type.');
    }
    if (body.value.type !== 'response.create') return fail(`Unsupported WebSocket event type '${body.value.type}'.`);
    const payload = canonicalizeOpenAIResponsesPayload({ ...openAIResponsesWebSocketPayload(body.value), stream: true });
    if (!('input' in payload)) return fail(payload.error.message, payload.error);

    return await scope.next({
      ...facts,
      'request.openaiResponses': payload,
      'request.delivery': openAIResponsesDelivery(true, facts['serve.startedAt']),
    });
  },
});
