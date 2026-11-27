import { expect, test, vi } from 'vitest';

import { openAIResponsesHostedTools } from '../../../../../src/data-plane/chat/openai-responses/pipeline/hosted-tools.ts';
import { compose, defineStage } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import { customCandidate, post, setupNonChat } from '../../../non-chat/fixtures.ts';
import { candidateFor } from '../../../pipeline/fixtures.ts';
import type { Fetcher } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const response = (status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_search',
  object: 'response',
  model: 'wire-model',
  status,
  output: [],
  error: null,
  incomplete_details: null,
});

const searchCommands = { search_query: [{ q: 'Floway' }] };
const input: CanonicalOpenAIResponsesPayload['input'] = [{ type: 'message', role: 'user', content: 'Search' }];

const runHostedSearch = async (searchResponse: Response, commands: Record<string, unknown> = searchCommands) => {
  const search = customCandidate('alpha-search', { upstreamModelId: 'wire-search' });
  const fetcher = vi.fn<Fetcher>(async () => searchResponse);
  const fixture = await setupNonChat([search], () => fetcher);
  fixture.services.localWebSearch.passthroughConfiguration = async () => ({ enabled: true, upstreamId: search.upstream.id, model: 'configured-search' });
  const localBackend = vi.fn(async () => { throw new Error('Unexpected local web-search fallback'); });
  fixture.services.localWebSearch.getBackend = localBackend;
  const host = fixture.host();
  const requests: CanonicalOpenAIResponsesPayload[] = [];
  const toolCall = {
    type: 'function_call',
    id: 'fc_search',
    call_id: 'call_search',
    name: 'web_search',
    arguments: JSON.stringify(commands),
    status: 'completed',
  } as const;
  const ending = defineStage({
    name: 'responses-round',
    request: { needs: ['openaiResponses'] },
    return: { provides: ['http', 'openaiResponses'] },
    async execute({ openaiResponses }, scope) {
      const round = requests.push(openaiResponses);
      const stream = scope.createStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>(async function* () {
        yield { ok: true, value: { type: 'response.created', response: response('in_progress') } };
        if (round === 1) {
          yield { ok: true, value: { type: 'response.output_item.added', output_index: 0, item: { ...toolCall, arguments: '', status: 'in_progress' } } };
          yield { ok: true, value: { type: 'response.output_item.done', output_index: 0, item: toolCall } };
        }
        yield { ok: true, value: { type: 'response.completed', response: response('completed') } };
      });
      return { http: null, openaiResponses: { kind: 'stream', stream } };
    },
  });
  const entry = asEntry(compose('responses-hosted-alpha-search', {
    entry: ['http', 'model', 'chat.target', 'openaiResponses'],
    exit: ['http', 'openaiResponses'],
    stages: [openAIResponsesHostedTools],
    ending,
  }));
  const { model } = candidateFor('responses');
  const execution = run(entry, {
    http: post(null, '/v1/responses').http,
    model,
    'chat.target': 'openaiChatCompletions',
    openaiResponses: {
      model: model.id, input, tools: [{ type: 'web_search', external_web_access: true }], tool_choice: { type: 'web_search' },
    },
  }, host.options);
  const answer = await execution.result;
  let failure: ProtocolStreamError | undefined;
  try {
    if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected hosted Responses output');
    for await (const item of execution.read(answer.openaiResponses.stream)) {
      if (!item.ok) failure = item.error;
    }
  } finally {
    host.controller.abort();
    execution.discard(answer);
    await host.settle();
  }
  expect(host.errors).toEqual([]);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(localBackend).not.toHaveBeenCalled();
  return { requests, failure, sent: JSON.parse(String(fetcher.mock.calls[0]?.[1].body)) };
};

test('hosted Alpha Search replays exact model-facing output and keeps opaque results out of the replay', async () => {
  const { requests, failure, sent } = await runHostedSearch(Response.json({
    output: 'exact upstream output',
    encrypted_output: 'opaque',
    results: [{ type: 'future-result', title: 'opaque upstream UI data' }],
  }));
  expect(failure).toBeUndefined();
  expect(sent).toMatchObject({ id: expect.any(String), input, commands: searchCommands, settings: { external_web_access: true } });
  expect(requests).toHaveLength(2);
  expect(requests[1].input).toContainEqual(expect.objectContaining({
    type: 'function_call_output', call_id: 'call_search', output: 'exact upstream output',
  }));
});

test('hosted Alpha Search surfaces an upstream error and ends the current turn', async () => {
  const { requests, failure } = await runHostedSearch(new Response('upstream unavailable', { status: 503 }));
  expect(failure).toMatchObject({ kind: 'protocol' });
  expect(requests).toHaveLength(1);
});

test('hosted Alpha Search replays a cascaded capability error exactly', async () => {
  const message = 'The configured web search provider does not implement OpenAI search feature `commands.image_query`.';
  const commands = { image_query: [{ q: 'cat' }] };
  const { requests, failure, sent } = await runHostedSearch(Response.json({
    error: { type: 'internal_error', name: 'UnsupportedLocalWebSearchFeatureError', message },
  }, { status: 500 }), commands);
  expect(failure).toBeUndefined();
  expect(sent).toMatchObject({ commands });
  expect(requests).toHaveLength(2);
  expect(requests[1].input).toContainEqual(expect.objectContaining({
    type: 'function_call_output', call_id: 'call_search', output: message,
  }));
});
