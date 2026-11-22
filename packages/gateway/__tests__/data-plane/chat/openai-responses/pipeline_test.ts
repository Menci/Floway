import { expect, test } from 'vitest';

import { stubResponsesProviderPipeline } from './provider-pipeline.ts';
import { openaiResponsesGeneratePipeline } from '../../../../src/data-plane/chat/openai-responses/serve.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { stubRouteCandidate, mockChatPipelineServices } from '../../../test-utils/chat-pipeline.ts';
import { createDumpDecoder, createDumpEncoder, runPipeline } from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const traceSink = () => {
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      push: event => chunks.push(new TextEncoder().encode(`${JSON.stringify(encoder.encodeBatch([event])[0])}\n`)),
    } satisfies RunTraceSink,
    read: () => createDumpDecoder().pushNdjsonChunk(new TextEncoder().encode(
      chunks.map(chunk => new TextDecoder().decode(chunk)).join(''),
    ), { final: true }),
  };
};

const result: import('@floway-dev/protocols/openai-responses').OpenAIResponsesResultEx = {
  id: 'resp_pipeline_test', object: 'response', model: 'test-model', status: 'completed', output: [],
  error: null, incomplete_details: null, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
};

const provider = stubResponsesProviderPipeline(
  'provider.responses',
  async (_facts, env) => ({
    action: 'generate',
    ok: true,
    events: env.createStream({
      async *iterate() {
        yield eventFrame({ type: 'response.created', sequence_number: 0, response: result });
        yield eventFrame({ type: 'response.completed', sequence_number: 1, response: result });
        yield doneFrame();
      },
    }),
    modelKey: 'raw-model',
    http: { status: 200, statusText: 'OK', headers: Object.freeze([Object.freeze(['content-type', 'text/event-stream'] as const)]), timing: { startedAtMs: 1, headersAtMs: 2 } },
  }),
);

test('OpenAI Responses generate enters a traced pipeline and dispatches through the provider pipeline', async () => {
  initRepo(new InMemoryRepo());
  const candidate = stubRouteCandidate({ endpoints: { openaiResponses: {} }, modelId: 'public-model', upstreamModelId: 'raw-model' });
  const { ctx, services } = mockChatPipelineServices({
    ctxOverrides: { wantsStream: false },
    entries: [{ candidate, pipelines: { openaiResponses: provider } }],
  });
  const trace = traceSink();
  const outcome = await runPipeline(openaiResponsesGeneratePipeline, {
    'request.http': {
      method: 'POST', url: 'https://gateway.example/v1/responses', headers: [['content-type', 'application/json']],
      body: { kind: 'json', value: { model: 'public-model', input: 'hello' } }, protocol: 'openai-responses',
    },
    'request.inboundHeaders': [],
    'request.payload': { model: 'public-model', input: [{ type: 'message', role: 'user', content: 'hello' }] },
    'request.action': 'generate', 'request.wantsStream': false,
  }, { services, traceSink: trace.sink });
  expect(outcome.status).toBe(200);

  const decoded = trace.read();
  expect([...decoded.stages.values()].map(stage => stage.name)).toContain('gateway.openai-responses.prepare');
  expect([...decoded.stages.values()].map(stage => stage.name)).toContain('agentMessageShim');
  expect([...decoded.stages.values()].find(stage => stage.name === 'gateway.openai-responses.prepare')?.facts['request.http']).toBeDefined();
  expect([...decoded.stages.values()].some(stage => stage.name === 'agentMessageShim')).toBe(true);
  expect(ctx.wantsStream).toBe(false);
});
