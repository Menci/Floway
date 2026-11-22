import { expect, test } from 'vitest';

import { openaiChatCompletionsPipeline } from '../../../../src/data-plane/chat/openai-chat-completions/pipeline.ts';
import { createChatPipelineServices } from '../../../../src/data-plane/chat/pipeline/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../../src/data-plane/providers/models-cache.ts';
import type { AuthedContext } from '../../../../src/middleware/auth.ts';
import { modelsRefreshInputs } from '../../../../src/repo/models-refresh-inputs.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, sseOpenAIChatCompletionsResponse } from '../../../test-utils/app.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { createDumpDecoder, createDumpEncoder, projectWireView } from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import { stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

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

test('native OpenAI Chat Completions dispatches through the provider pipeline and projects the wire body', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const model = stubProviderModel({
    id: 'public-chat',
    upstreamModelId: 'raw-chat',
    kind: 'chat',
    endpoints: { openaiChatCompletions: {} },
  });
  const record = buildCustomUpstreamRecord({
    id: 'up_chat',
    name: 'Chat Pipeline Provider',
    config: {
      baseUrl: 'https://chat.pipeline.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-chat',
      endpoints: { openaiChatCompletions: {} },
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [model],
    },
  });
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = await repo.upstreams.getById(record.id);
  if (stored === null) throw new Error('missing seeded chat upstream');
  await repo.upstreams.publishModelsRefresh({
    id: stored.id,
    configVersion: stored.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(stored),
    cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models: [model] },
  });

  const ctx = mockChatGatewayCtx({ wantsStream: false });
  const services = createChatPipelineServices(ctx);
  const trace = traceSink();
  const c = { req: { method: 'POST', url: 'https://gateway.example/v1/chat/completions' } } as unknown as AuthedContext;
  await withMockedFetch(
    async () => sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl_native',
      object: 'chat.completion',
      created: 1,
      model: 'raw-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }),
    async () => {
      const { runGatewayHttpPipeline } = await import('../../../../src/data-plane/pipeline/index.ts');
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
      await response.text();
    },
  );

  const wire = projectWireView(trace.read());
  expect(wire.upstreamAttempts).toHaveLength(1);
  expect(wire.upstreamAttempts[0]).toMatchObject({
    candidate: { upstreamId: 'up_chat', modelId: 'public-chat', upstreamModelId: 'raw-chat' },
    request: {
      url: { origin: 'https://chat.pipeline.example.com', pathname: '/v1/chat/completions' },
      body: {
        kind: 'json',
        value: {
          model: 'raw-chat',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          stream_options: { include_usage: true },
        },
      },
    },
  });
});
