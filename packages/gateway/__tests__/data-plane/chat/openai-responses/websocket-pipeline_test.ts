import { expect, test } from 'vitest';

import { openaiResponsesWebSocketTurnPipeline } from '../../../../src/data-plane/chat/openai-responses/websocket.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createManagedProtocolFrames, mockChatPipelineServices, stubRouteCandidate } from '../../../test-utils/chat-pipeline.ts';
import { createDumpDecoder, createDumpEncoder, pipeline, projectWireView, runPipeline, terminal } from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type {
  ProviderPipelineOpenAIResponsesInput,
  ProviderPipelineResponsesOutcome,
  ProviderPipelineServices,
} from '@floway-dev/provider';

test('a WebSocket turn runs as a traced pipeline with the WS wire snapshot', async () => {
  initRepo(new InMemoryRepo());
  const { services } = mockChatPipelineServices({ sawModel: false, entries: [] });
  const events: Parameters<RunTraceSink['push']>[0][] = [];
  const outcome = await runPipeline(openaiResponsesWebSocketTurnPipeline, {
    'request.http': {
      method: 'WS',
      url: 'https://gateway.test/v1/responses',
      headers: [['x-api-key', 'secret']],
      body: { type: 'response.create', event_id: 'evt_trace', response: { model: 'missing', input: 'hello' } },
      protocol: 'openai-responses-ws',
    },
    'request.inboundHeaders': [['x-api-key', 'secret']],
    'request.payload': { model: 'missing', input: [{ type: 'message', role: 'user', content: 'hello' }], stream: true },
    'request.responseId': 'resp_test',
  }, {
    services,
    traceSink: { push: event => events.push(event) },
    meta: { transport: 'websocket', action: 'generate' },
  });
  expect(outcome.type).toBe('api-error');
  const enters = events.filter(event => event.k === 'enter');
  const edge = enters.find(event => event.name === 'openai-responses.websocket.turn');
  expect(edge).toBeDefined();
  expect(edge?.tap).toBe('downstream');
  expect(edge?.facts['request.http']).toMatchObject({ method: 'WS', protocol: 'openai-responses-ws' });
  const run = events.find(event => event.k === 'run');
  expect(run).toMatchObject({ pipelineName: 'gateway.openai-responses.websocket.turn', meta: { transport: 'websocket' } });
});

test('a matched WebSocket turn dispatches candidate attempts on the main run spine and forwards allowlisted headers', async () => {
  initRepo(new InMemoryRepo());
  let observedHeaders: readonly (readonly [string, unknown])[] = [];
  const providerPipeline = pipeline<ProviderPipelineOpenAIResponsesInput>('test.ws.responses')
    .end(terminal<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome, ProviderPipelineServices>({
      name: 'test.ws.responses.upstream',
      tap: 'upstream',
      execute: async (facts, env) => {
        observedHeaders = facts['request.inboundHeaders'];
        return {
          action: 'generate',
          ok: true,
          events: createManagedProtocolFrames<OpenAIResponsesStreamEventEx>(env, [{
            type: 'response.completed',
            sequence_number: 0,
            response: { id: 'resp_ws_1', object: 'response', model: 'gpt-test', status: 'completed', output: [], error: null, incomplete_details: null },
          }]),
          modelKey: 'gpt-test',
          http: {
            status: 200,
            statusText: 'OK',
            headers: Object.freeze([Object.freeze(['content-type', 'text/event-stream'] as const)]),
            timing: { startedAtMs: 1, headersAtMs: 2 },
          },
        };
      },
    }));
  const candidate = stubRouteCandidate({
    upstreamId: 'up_ws',
    modelId: 'gpt-test',
    endpoints: { openaiResponses: {} },
  });
  const { services } = mockChatPipelineServices({
    entries: [{
      candidate,
      inboundHeaderAllowlist: ['x-trace-id'],
      pipelines: { openaiResponses: providerPipeline },
    }],
  });
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  const outcome = await runPipeline(openaiResponsesWebSocketTurnPipeline, {
    'request.http': {
      method: 'WS',
      url: 'https://gateway.test/v1/responses',
      headers: [['x-trace-id', 'trace-123'], ['x-ignored', 'drop']],
      body: { type: 'response.create', model: 'gpt-test', input: 'hello' },
      protocol: 'openai-responses-ws',
    },
    'request.inboundHeaders': [['x-trace-id', 'trace-123'], ['x-ignored', 'drop']],
    'request.payload': { model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], stream: true },
    'request.responseId': 'resp_ws_1',
  }, {
    services,
    traceSink: {
      push: event => {
        for (const encoded of encoder.encodeBatch([event])) {
          chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`));
        }
      },
    },
  });
  expect(outcome.type).toBe('events');
  if (outcome.type === 'events') {
    for await (const _frame of outcome.events) { /* drain */ }
  }
  expect(observedHeaders).toEqual([['x-trace-id', 'trace-123']]);
  const decoder = createDumpDecoder();
  const total = new Uint8Array(chunks.reduce((sum, item) => sum + item.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    total.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const wire = projectWireView(decoder.pushNdjsonChunk(total, { final: true }));
  expect(wire.upstreamAttempts).toHaveLength(1);
  expect(wire.upstreamAttempts[0]).toMatchObject({
    isSubRun: false,
    winning: true,
    candidate: { upstreamId: 'up_ws', modelId: 'gpt-test' },
  });
});
