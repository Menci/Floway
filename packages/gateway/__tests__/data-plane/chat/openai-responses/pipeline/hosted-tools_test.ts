import { expect, test, vi } from 'vitest';

import { DEFAULT_IMAGE_MODEL } from '../../../../../src/data-plane/chat/openai-responses/pipeline/hosted-tools/image-generation.ts';
import { consumeTurnStreaming, createMergeState, openAIResponsesHostedTools } from '../../../../../src/data-plane/chat/openai-responses/pipeline/hosted-tools.ts';
import { compose, defineStage } from '../../../../../src/data-plane/chat/pipeline/facts.ts';
import type { UsageObservation } from '../../../../../src/data-plane/pipeline/compute-usage.ts';
import { createGatewayServices, type GatewayServices } from '../../../../../src/data-plane/pipeline/services.ts';
import type { WebSearchBackend } from '../../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../../pipeline/fixtures.ts';
import type { Fetcher } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputFunctionCallEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ProtocolStreamError } from '@floway-dev/upstream';

const response = (status: OpenAIResponsesResultEx['status'], tokens = 0): OpenAIResponsesResultEx => ({
  id: 'resp_upstream',
  object: 'response',
  model: 'wire-model',
  status,
  output: [],
  error: null,
  incomplete_details: null,
  usage: { input_tokens: tokens, output_tokens: tokens, total_tokens: tokens * 2 },
});

const call = {
  type: 'function_call',
  id: 'fc_search',
  call_id: 'call_search',
  name: 'web_search',
  arguments: JSON.stringify({ search_query: [{ q: 'a test query' }] }),
  status: 'completed',
} as const;

const testServices = (): GatewayServices => {
  initRepo(new InMemoryRepo());
  return createGatewayServices({
    apiKey: { id: 'key', serverSecret: 'ab'.repeat(32), openaiResponsesRetentionSeconds: 0, upstreamIds: null, randomizeUpstreams: false },
    subject: { id: 1, isAdmin: false },
    runtimeLocation: 'TEST',
    dump: null,
  });
};

const startHostedTurn = (
  services: GatewayServices,
  tools: Pick<CanonicalOpenAIResponsesPayload, 'tools' | 'tool_choice'>,
  toolCall: OpenAIResponsesOutputFunctionCallEx,
) => {
  const host = hostFor(services);
  const requests: CanonicalOpenAIResponsesPayload[] = [];
  const ended: number[] = [];
  const upstream = defineStage({
    name: 'script-responses-round',
    request: { needs: ['openaiResponses'] },
    return: { provides: ['http', 'openaiResponses', 'usage', 'usageModelKey'] },
    async execute({ openaiResponses }, scope) {
      const round = requests.push(openaiResponses);
      const stream = scope.createStream<OpenAIResponsesStreamEventEx, ProtocolStreamError>(async function* () {
        yield { ok: true, value: { type: 'response.created', response: response('in_progress') } };
        if (round === 1) {
          yield { ok: true, value: { type: 'response.output_item.added', output_index: 0, item: { ...toolCall, arguments: '', status: 'in_progress' } } };
          yield { ok: true, value: { type: 'response.output_item.done', output_index: 0, item: toolCall } };
        }
        yield { ok: true, value: { type: 'response.completed', response: response('completed', round) } };
        ended.push(round);
      });
      return {
        http: null,
        openaiResponses: { kind: 'stream', stream },
        usage: scope.createDeferred(async (): Promise<UsageObservation> => ({ kind: 'observed', usage: [] })),
        usageModelKey: 'wire-model',
      };
    },
  });
  const entry = asEntry(compose('hosted-search-test', {
    entry: ['http', 'model', 'chat.target', 'openaiResponses'],
    exit: ['http', 'openaiResponses', 'usage?', 'usageModelKey?'],
    stages: [openAIResponsesHostedTools],
    ending: upstream,
  }));
  const { model } = candidateFor('custom');
  const execution = run(entry, {
    http: { url: 'https://floway.test/v1/responses', headers: [], method: 'POST', body: null },
    model,
    'chat.target': 'openaiChatCompletions',
    openaiResponses: { model: model.id, input: [], ...tools },
  }, host.options);

  return {
    host, execution, requests, ended,
    async finish(answer: Awaited<typeof execution.result>): Promise<OpenAIResponsesStreamEventEx[]> {
      const { openaiResponses: outcome } = answer;
      if (outcome.kind !== 'stream') throw new Error('Expected the hosted Responses stream');
      try {
        const frames: OpenAIResponsesStreamEventEx[] = [];
        for await (const item of execution.read(outcome.stream)) {
          if (!item.ok) throw item.error.cause;
          frames.push(item.value);
        }
        return frames;
      } finally {
        host.controller.abort();
        execution.discard(answer);
        await host.settle();
      }
    },
  };
};

test('a checked hosted search run feeds a producer-owned second Responses round', async () => {
  const defaults = testServices();
  const search = vi.fn<WebSearchBackend['search']>(async () => ({
    type: 'ok',
    results: [{ source: 'https://example.test/article', title: 'Search result', content: [{ type: 'text', text: 'Article content' }] }],
  }));
  const { host, execution, requests, ended, finish } = startHostedTurn({
    ...defaults,
    localWebSearch: {
      ...defaults.localWebSearch,
      getBackend: async () => ({
        type: 'enabled',
        backend: 'tavily',
        impl: { search, fetchPage: async () => { throw new Error('Unexpected page fetch'); } },
      }),
    },
  }, { tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' } }, call);
  const answer = await execution.result;
  expect(requests).toHaveLength(1);
  expect(search).not.toHaveBeenCalled();
  const frames = await finish(answer);
  expect(search).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ query: 'a test query', signal: expect.any(AbortSignal) }));
  expect(requests).toHaveLength(2);
  expect(requests[0].tools).toEqual([expect.objectContaining({ type: 'function', name: 'web_search' })]);
  expect(requests[1].input).toEqual([
    expect.objectContaining({ type: 'function_call', call_id: call.call_id }),
    expect.objectContaining({ type: 'function_call_output', call_id: call.call_id, output: expect.stringContaining('Search result') }),
  ]);
  expect(requests[1].tool_choice).toBe('auto');
  expect(ended).toEqual([1, 2]);
  expect(host.errors).toEqual([]);
  expect(frames.filter(frame => frame.type === 'response.created')).toHaveLength(1);
  expect(frames.find(frame => frame.type === 'response.completed')).toMatchObject({
    response: {
      output: [expect.objectContaining({ type: 'reasoning', encrypted_content: expect.any(String) }), expect.objectContaining({ type: 'web_search_call', status: 'completed' })],
      usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 },
    },
  });
});

test('a checked hosted image run relays partial frames and replays its final image', async () => {
  const defaults = testServices();
  const candidate = candidateFor('images');
  const image = {
    upstream: {
      ...candidate.upstream,
      config: {
        apiKey: 'wire-key',
        baseUrl: 'https://image.test',
        endpoints: {},
        ingressHeadersRules: [],
        modelsFetch: { enabled: false, authStyle: 'bearer' },
      },
    },
    model: {
      ...candidate.model,
      id: DEFAULT_IMAGE_MODEL,
      upstreamModelId: 'native-image-model',
      kind: 'image' as const,
      endpoints: { openaiImagesGenerations: {} },
    },
  };
  const catalogCandidates = vi.fn<GatewayServices['catalogCandidates']>(async () => ({ candidates: [image], sawModel: true }));
  const imageBody = [
    { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'cHJldmlldw==' },
    { type: 'image_generation.completed', b64_json: 'aW1hZ2U=' },
  ].map(({ type, ...data }) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const fetcher = vi.fn<Fetcher>(async () => new Response(imageBody, { headers: { 'content-type': 'text/event-stream' } }));
  const { execution, requests, host, finish } = startHostedTurn({
    ...defaults,
    catalogCandidates,
    fetcher: () => fetcher,
    recordUsage: async () => {},
    recordPerformance: async () => {},
  }, { tools: [{ type: 'image_generation', partial_images: 1 }] }, {
    ...call,
    name: 'image_generation',
    arguments: '{"prompt":"Draw the skyline"}',
  });
  const answer = await execution.result;
  expect(fetcher).not.toHaveBeenCalled();
  const frames = await finish(answer);

  expect(catalogCandidates).toHaveBeenCalledExactlyOnceWith({ model: DEFAULT_IMAGE_MODEL, kind: 'image' });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe('https://image.test/v1/images/generations');
  if (typeof init.body !== 'string') throw new Error('Expected an OpenAI Images JSON request');
  expect(JSON.parse(init.body)).toMatchObject({ model: 'native-image-model', prompt: 'Draw the skyline', stream: true, partial_images: 1 });
  expect(frames.find(frame => frame.type === 'response.image_generation_call.partial_image')).toMatchObject({
    partial_image_index: 0, partial_image_b64: 'cHJldmlldw==',
  });
  expect(requests[1].input).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'message', role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' })]) }),
  ]));
  expect(host.errors).toEqual([]);
});

test('namespaced tool-shaped output cannot retain unbounded argument frames', async () => {
  let emitted = 0;
  const source = async function* () {
    yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.created', response: response('in_progress') });
    yield eventFrame<OpenAIResponsesStreamEventEx>({
      type: 'response.output_item.added', output_index: 0,
      item: { ...call, namespace: 'client', arguments: '', status: 'in_progress' },
    });
    const delta = 'x'.repeat(1024 * 1024);
    for (let index = 0; index <= 64; index++) {
      emitted++;
      yield eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta });
    }
  };
  const dispatch = vi.fn(() => []);
  const frames = consumeTurnStreaming(source(), createMergeState(), true, new Map([[call.name, dispatch]]), { iterationCount: 1, remainingToolCalls: undefined }, []);
  const drain = async () => {
    for await (const _frame of frames) { /* Pull through the buffer limit. */ }
  };
  await expect(drain()).rejects.toThrow(/hosted tool buffer exceeds/);
  expect(emitted).toBeLessThan(65);
  expect(dispatch).not.toHaveBeenCalled();
});
