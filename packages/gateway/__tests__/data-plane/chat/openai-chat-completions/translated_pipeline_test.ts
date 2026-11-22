import { expect, test, vi } from 'vitest';

vi.mock('../../../../src/data-plane/chat/anthropic-messages/attempt-pipeline.ts', async () => {
  const { pipeline, defineRequestStage, terminal } = await import('@floway-dev/pipeline');
  const { doneFrame, eventFrame } = await import('@floway-dev/protocols/common');
  const translatedPipeline = pipeline<any>('stub.anthropic-messages.attempt')
    .use(defineRequestStage<any, { readonly 'request.http': import('@floway-dev/pipeline').WireRequestSnapshot }>({
      name: 'stub.anthropic-messages.request',
      provides: ['request.http'],
      execute: async (facts, next) => await next({
        'request.http': {
          method: 'POST',
          url: 'https://messages.translated.example.com/v1/messages',
          headers: [],
          body: { kind: 'json', value: facts['request.payload'] },
        },
      }),
    }))
    .end(terminal<any, any, any>({
      name: 'stub.anthropic-messages.upstream',
      tap: 'upstream',
      execute: async (facts, env) => ({
        type: 'events',
        events: env.createStream({
          label: 'stub.anthropic-messages.events',
          async *iterate() {
            yield eventFrame({
              type: 'message_start',
              message: {
                id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'raw-chat',
                stop_reason: null, stop_sequence: null,
                usage: { input_tokens: 2, output_tokens: 0 },
              },
            });
            yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } });
            yield eventFrame({ type: 'content_block_stop', index: 0 });
            yield eventFrame({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            });
            yield eventFrame({ type: 'message_stop' });
            yield doneFrame();
          },
        }),
        modelIdentity: {
          model: facts['route.candidate'].modelId,
          upstream: facts['route.candidate'].upstreamId,
          modelKey: 'raw-chat',
          pricing: null,
        },
        http: { status: 200, headers: [] },
      }),
    }));
  return {
    anthropicMessagesAttemptPipeline: translatedPipeline,
    anthropicMessagesCountTokensAttemptPipeline: translatedPipeline,
  };
});

const { openaiChatCompletionsPipeline } = await import('../../../../src/data-plane/chat/openai-chat-completions/pipeline.ts');
const { createChatPipelineServices } = await import('../../../../src/data-plane/chat/pipeline/index.ts');
const { MODEL_CATALOG_REVISION } = await import('../../../../src/data-plane/providers/models-cache.ts');
const { modelsRefreshInputs } = await import('../../../../src/repo/models-refresh-inputs.ts');
const { saveUpstreamForTest } = await import('../../../repo/upstreams.ts');
const { buildCustomUpstreamRecord, setupAppTest } = await import('../../../test-utils/app.ts');
const { mockChatGatewayCtx } = await import('../../../test-utils/gateway-ctx.ts');
const { createDumpDecoder, createDumpEncoder, projectWireView } = await import('@floway-dev/pipeline');
const { runGatewayHttpPipeline } = await import('../../../../src/data-plane/pipeline/index.ts');
const { stubProviderModel } = await import('@floway-dev/test-utils');
import type { AuthedContext } from '../../../../src/middleware/auth.ts';
import type { RunTraceSink } from '@floway-dev/pipeline';

const traceSink = (): { readonly sink: RunTraceSink; readonly read: () => ReturnType<ReturnType<typeof createDumpDecoder>['pushNdjsonChunk']> } => {
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      push: event => {
        for (const encoded of encoder.encodeBatch([event])) chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`));
      },
    },
    read: () => {
      const decoder = createDumpDecoder();
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return decoder.pushNdjsonChunk(bytes, { final: true });
    },
  };
};

test('translated OpenAI Chat Completions projects the Messages wire and applies the source translation', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const providerModel = stubProviderModel({
    id: 'public-chat',
    upstreamModelId: 'raw-chat',
    kind: 'chat',
    endpoints: { anthropicMessages: {} },
  });
  const record = buildCustomUpstreamRecord({
    id: 'up_messages',
    name: 'Messages Pipeline Provider',
    config: {
      baseUrl: 'https://messages.pipeline.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-messages',
      endpoints: { anthropicMessages: {} },
      modelsFetch: { enabled: false, authStyle: 'x-api-key' },
      models: [providerModel],
    },
  });
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = await repo.upstreams.getById(record.id);
  if (stored === null) throw new Error('missing seeded Messages upstream');
  await repo.upstreams.publishModelsRefresh({
    id: stored.id,
    configVersion: stored.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(stored),
    cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models: [providerModel] },
  });

  const ctx = mockChatGatewayCtx({ wantsStream: false });
  const services = createChatPipelineServices(ctx);
  const trace = traceSink();
  const c = { req: { method: 'POST', url: 'https://gateway.example/v1/chat/completions' } } as unknown as AuthedContext;
  const response = await runGatewayHttpPipeline(c, ctx, openaiChatCompletionsPipeline, {
    'request.http': {
      method: 'POST',
      url: 'https://gateway.example/v1/chat/completions',
      headers: [['content-type', 'application/json']],
      body: { kind: 'json', value: { model: 'public-chat', messages: [{ role: 'user', content: 'hi' }] } },
      protocol: 'openai-chat-completions',
    },
    'request.inboundHeaders': [],
    'request.payload': { model: 'public-chat', messages: [{ role: 'user', content: 'hi' }] },
    'request.wantsStream': false,
    'request.includeUsageChunk': false,
    'request.expectedChoices': 1,
  }, { services, traceSink: trace.sink });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  });

  const model = trace.read();
  const wire = projectWireView(model);
  expect(wire.upstreamAttempts).toHaveLength(1);
  expect(wire.upstreamAttempts[0].request).toMatchObject({
    url: 'https://messages.translated.example.com/v1/messages',
    body: {
      kind: 'json',
      value: {
        model: 'public-chat',
        max_tokens: expect.any(Number),
        stream: true,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      },
    },
  });
  const translateStage = [...model.stages.values()].find(stage => stage.name === 'translateOrNative');
  expect(translateStage?.facts['route.targetApi']).toBe('anthropicMessages');
});
