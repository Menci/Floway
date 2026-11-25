import { gatewayFactSpace } from '../../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../../pipeline/response.ts';
import { appendFailedUpstreams } from '../../../shared/failed-upstreams.ts';
import { prepareJsonModelRequest } from '../../../shared/json-model-request.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { TranslateInputError } from '@floway-dev/translate';

const { defineStage } = gatewayFactSpace<{}>();

const errorBody = (message: string, fields?: { readonly param: string; readonly code: string | null }) => ({
  error: { message, type: 'invalid_request_error', ...fields },
});

export const openAIChatCompletionsInputError = (error: TranslateInputError) =>
  errorBody(error.message, { param: error.param ?? 'messages', code: null });

const protocolError = (status: number, error: ReturnType<typeof errorBody>) => ({
  'response.http': move(responseHead(status)),
  'response.openaiChatCompletions': move({ kind: 'error', source: 'local', error } as const),
});

export const openAIChatCompletionsAffinityUnavailable = (message: string) =>
  protocolError(400, errorBody(message, { param: 'input', code: 'responses_item_routing_unavailable' }));

export const openAIChatCompletionsModelUnavailable = (
  model: string,
  { sawModel, failedUpstreams }: { readonly sawModel: boolean; readonly failedUpstreams: readonly string[] },
) => protocolError(sawModel ? 400 : 404, errorBody(appendFailedUpstreams(sawModel
  ? `Model ${model} does not support the /chat/completions endpoint.`
  : `Model ${model} is not available on any configured upstream.`, failedUpstreams)));

const invalidRequest = (error: ReturnType<typeof errorBody>) => ({ 'response.http': move(jsonResponseBody(responseHead(400), error)) });

export const parseOpenAIChatCompletions = defineStage({
  name: 'openaiChatCompletions.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiChatCompletions', 'request.delivery', 'serve.model'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return invalidRequest(errorBody('OpenAI Chat Completions request body must be valid JSON.'));

    const request = prepareJsonModelRequest(raw.value, 'OpenAI Chat Completions');
    if (request.type === 'invalid') return invalidRequest(errorBody(request.message));
    const { body, model } = request;
    const nullableField = body.prompt_cache_options === null ? 'prompt_cache_options' : body.user === null ? 'user' : undefined;
    if (nullableField !== undefined) return invalidRequest(errorBody(
      `Invalid '${nullableField}': expected ${nullableField === 'user' ? 'a string' : 'an object'} when present.`,
      { param: nullableField, code: null },
    ));
    if (!Array.isArray(body.messages)) return invalidRequest(openAIChatCompletionsInputError({
      type: 'input-error', message: 'OpenAI Chat Completions request body must include a messages array.',
    }));

    const payload = body as OpenAIChatCompletionsPayloadEx;
    return await scope.next({
      ...facts,
      'request.openaiChatCompletions': move(payload),
      'request.delivery': move({
        kind: 'openaiChatCompletions',
        stream: payload.stream === true,
        includeUsageChunk: payload.stream_options?.include_usage === true,
        expectedChoices: payload.n ?? 1,
      } as const),
      'serve.model': model,
    });
  },
});
