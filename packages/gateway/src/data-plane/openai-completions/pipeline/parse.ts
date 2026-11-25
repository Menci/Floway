import { gatewayFactSpace } from '../../pipeline/facts.ts';
import { jsonResponseBody, responseHead } from '../../pipeline/response.ts';
import { prepareJsonModelRequest } from '../../shared/json-model-request.ts';
import { readHttpBody } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';
import { formatOpenAICompletionsError } from '@floway-dev/protocols/openai-completions';

const { defineStage } = gatewayFactSpace<{}>();

export const openAICompletionsError = (status: number, message: string) => ({
  'response.http': move(responseHead(status)),
  'response.openaiCompletions': move({ kind: 'error', source: 'local', error: formatOpenAICompletionsError(status, message) } as const),
});

const invalid = (message: string) => ({
  'response.http': move(jsonResponseBody(responseHead(400), formatOpenAICompletionsError(400, message))),
});

export const parseOpenAICompletions = defineStage({
  name: 'openaiCompletions.parse-request',
  through: {
    request: { needs: ['request.http'], provides: ['request.openaiCompletions', 'request.delivery', 'serve.model'], consumes: [] },
    response: { needs: ['response.http'], provides: [], consumes: [] },
  },
  return: { provides: ['response.http'] },
  async execute(facts, scope) {
    const raw = await readHttpBody(facts['request.http'].body);
    if (!raw.ok) return invalid('OpenAI Completions request body must be valid JSON.');
    const request = prepareJsonModelRequest(raw.value, 'OpenAI Completions');
    if (request.type === 'invalid') return invalid(request.message);

    const wantsStream = request.body.stream === true;
    const streamOptions = request.body.stream_options as { include_usage?: unknown } | null | undefined;
    const upstream = wantsStream
      ? { ...request.body, stream_options: { ...streamOptions, include_usage: true } }
      : request.body;

    return await scope.next({
      ...facts,
      'request.delivery': move(wantsStream ? { kind: 'sse', includeUsage: streamOptions?.include_usage === true } : { kind: 'json' }),
      'request.openaiCompletions': move({ ...upstream, model: request.model }),
      'serve.model': request.model,
    });
  },
});
