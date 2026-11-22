import { expect, test } from 'vitest';

import { geminiGenerateContentPipeline } from '../../../../src/data-plane/chat/gemini-generate-content/pipeline.ts';
import { createChatPipelineServices } from '../../../../src/data-plane/chat/pipeline/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../../src/data-plane/providers/models-cache.ts';
import type { AuthedContext } from '../../../../src/middleware/auth.ts';
import { modelsRefreshInputs } from '../../../../src/repo/models-refresh-inputs.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../../test-utils/app.ts';
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

const saveGeminiUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  const model = stubProviderModel({
    id: 'public-gemini',
    upstreamModelId: 'raw-gemini',
    kind: 'chat',
    endpoints: { geminiGenerateContent: {} },
  });
  const record = buildCustomUpstreamRecord({
    id: 'up_gemini',
    name: 'Gemini Pipeline Provider',
    config: {
      baseUrl: 'https://gemini.pipeline.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-gemini',
      endpoints: { geminiGenerateContent: {} },
      modelsFetch: { enabled: false, authStyle: 'x-goog-api-key' },
      models: [model],
    },
  });
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = await repo.upstreams.getById(record.id);
  if (stored === null) throw new Error('missing seeded Gemini upstream');
  await repo.upstreams.publishModelsRefresh({
    id: stored.id,
    configVersion: stored.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(stored),
    cache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models: [model] },
  });
};

test('native Gemini generateContent dispatches through the provider pipeline and preserves the URL model', async () => {
  const { repo } = await setupAppTest();
  await saveGeminiUpstream(repo);
  const ctx = mockChatGatewayCtx({ wantsStream: false });
  const services = createChatPipelineServices(ctx);
  const trace = traceSink();
  const c = { req: { method: 'POST', url: 'https://gateway.example/v1beta/models/public-gemini:generateContent' } } as unknown as AuthedContext;

  await withMockedFetch(
    async () => new Response(
      `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
    async () => {
      const { runGatewayHttpPipeline } = await import('../../../../src/data-plane/pipeline/index.ts');
      const response = await runGatewayHttpPipeline(c, ctx, geminiGenerateContentPipeline, {
        'request.http': {
          method: 'POST',
          url: 'https://gateway.example/v1beta/models/public-gemini:generateContent',
          headers: [['content-type', 'application/json']],
          body: { kind: 'json', value: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } },
          protocol: 'gemini-generate-content',
        },
        'request.inboundHeaders': [],
        'request.model': 'public-gemini',
        'request.payload': { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        'request.wantsStream': false,
      }, { services, traceSink: trace.sink });
      expect(response.status).toBe(200);
      await response.text();
    },
  );

  const wire = projectWireView(trace.read());
  expect(wire.upstreamAttempts).toHaveLength(1);
  expect(wire.upstreamAttempts[0].request).toMatchObject({
    url: {
      origin: 'https://gemini.pipeline.example.com',
      pathname: '/v1beta/models/raw-gemini:streamGenerateContent',
    },
    body: {
      kind: 'json',
      value: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    },
  });
});

test('traces native Gemini as a dispatch subtree beneath translateOrNative', async () => {
  const { repo } = await setupAppTest();
  await saveGeminiUpstream(repo);
  const ctx = mockChatGatewayCtx({ wantsStream: false });
  const services = createChatPipelineServices(ctx);
  const trace = traceSink();
  const c = { req: { method: 'POST', url: 'https://gateway.example/v1beta/models/public-gemini:generateContent' } } as unknown as AuthedContext;

  await withMockedFetch(
    async () => new Response(
      `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
    async () => {
      const { runGatewayHttpPipeline } = await import('../../../../src/data-plane/pipeline/index.ts');
      const response = await runGatewayHttpPipeline(c, ctx, geminiGenerateContentPipeline, {
        'request.http': {
          method: 'POST',
          url: 'https://gateway.example/v1beta/models/public-gemini:generateContent',
          headers: [['content-type', 'application/json']],
          body: { kind: 'json', value: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] } },
          protocol: 'gemini-generate-content',
        },
        'request.inboundHeaders': [],
        'request.model': 'public-gemini',
        'request.payload': { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
        'request.wantsStream': false,
      }, { services, traceSink: trace.sink });
      await response.text();
    },
  );

  const model = trace.read();
  const attempt = projectWireView(model).upstreamAttempts[0];
  let nativeStage = model.stages.get(attempt.stageId);
  while (nativeStage !== undefined && nativeStage.edgeKind !== 'dispatch') {
    nativeStage = nativeStage.parentStageId === null ? undefined : model.stages.get(nativeStage.parentStageId);
  }
  expect(nativeStage?.edgeKind).toBe('dispatch');
  const translateStage = [...model.stages.values()].find(stage => stage.name === 'translateOrNative');
  expect(translateStage?.facts['route.targetApi']).toBe('geminiGenerateContent');
});
