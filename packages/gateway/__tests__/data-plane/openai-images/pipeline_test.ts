import { expect, test } from 'vitest';

import { openaiImagesEditsPipeline } from '../../../src/data-plane/openai-images/pipeline.ts';
import { imageGenerationSubPipeline } from '../../../src/data-plane/openai-images/subrun.ts';
import { createGatewayPipelineServices, runGatewayHttpPipeline } from '../../../src/data-plane/pipeline/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import type { AuthedContext } from '../../../src/middleware/auth.ts';
import { modelsRefreshInputs } from '../../../src/repo/models-refresh-inputs.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import {
  createDumpDecoder,
  createDumpEncoder,
  defineStage,
  pipeline,
  projectWireView,
  runPipeline,
  terminal,
} from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import { readManagedBytes, type HttpOutcome, type RouteCandidate } from '@floway-dev/provider';
import { jsonResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const imageModel = (id: string) => stubProviderModel({
  id,
  upstreamModelId: id,
  kind: 'image',
  endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} },
});

const saveImageUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
): Promise<void> => {
  const model = imageModel('gpt-image-2');
  await repo.upstreams.deleteAll();
  const record = buildCustomUpstreamRecord({
    id: 'up_image_pipeline',
    name: 'Image Pipeline Provider',
    sortOrder: 1,
    modelsCache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models: [model], lastError: null },
    config: {
      baseUrl: 'https://images.pipeline.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
    },
  });
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = await repo.upstreams.getById(record.id);
  if (stored === null) throw new Error(`missing seeded upstream ${record.id}`);
  await repo.upstreams.publishModelsRefresh({
    id: stored.id,
    configVersion: stored.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(stored),
    cache: {
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: Date.now(),
      models: [model],
    },
  });
};

const traceSink = (): { readonly sink: RunTraceSink; readonly read: () => ReturnType<ReturnType<typeof createDumpDecoder>['pushNdjsonChunk']> } => {
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      push: event => {
        for (const encoded of encoder.encodeBatch([event])) {
          chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`));
        }
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

test('openaiImagesEditsPipeline projects pure multipart wire data through Dump V2', async () => {
  const { repo } = await setupAppTest();
  await saveImageUpstream(repo);
  const ctx = mockGatewayCtx();
  const trace = traceSink();
  const c = {
    req: { method: 'POST', url: 'https://gateway.example/v1/images/edits' },
  } as unknown as AuthedContext;

  await withMockedFetch(
    () => jsonResponse({ data: [{ b64_json: 'aW1n' }] }),
    async () => {
      const response = await runGatewayHttpPipeline(c, ctx, openaiImagesEditsPipeline, {
        'request.http': {
          method: 'POST',
          url: 'https://gateway.example/v1/images/edits',
          headers: [['content-type', 'multipart/form-data; boundary=test']],
          body: {
            kind: 'multipart',
            parts: [
              { kind: 'text', name: 'model', value: 'gpt-image-2' },
              { kind: 'text', name: 'prompt', value: 'replace sky' },
              {
                kind: 'file',
                name: 'image',
                bytes: new Uint8Array([1, 2, 3]),
                filename: 'photo.png',
                contentType: 'image/png',
              },
            ],
          },
          protocol: 'openai-images-edits',
        },
        'request.inboundHeaders': [],
        'request.model': 'gpt-image-2',
        'request.payload': {
          images: [{
            type: 'upload',
            bytes: new Uint8Array([1, 2, 3]),
            filename: 'photo.png',
            contentType: 'image/png',
          }],
          parameters: { prompt: 'replace sky' },
        },
      }, { services: createGatewayPipelineServices(ctx), traceSink: trace.sink });
      expect(response.status).toBe(200);
      await response.text();
    },
  );

  const wire = projectWireView(trace.read());
  const body = wire.downstreamRequest?.body as { kind: string; parts: Array<Record<string, unknown>> };
  expect(body.kind).toBe('multipart');
  expect(body.parts.find(part => part.name === 'image')).toMatchObject({
    kind: 'file',
    filename: 'photo.png',
    contentType: 'image/png',
  });
  expect(body.parts.find(part => part.name === 'image')?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  expect(body.parts.some(part => part.value instanceof File || part.value instanceof FormData)).toBe(false);
});

test('imageGenerationSubPipeline runs through spawnSubRun and publishes an upstream sub-run attempt', async () => {
  const { repo } = await setupAppTest();
  await saveImageUpstream(repo);
  const ctx = mockGatewayCtx();
  const services = createGatewayPipelineServices(ctx);
  const trace = traceSink();
  const outer = pipeline<Record<never, never>>('hosted-image-generation')
    .use(defineStage<
      Record<never, never>,
      Record<never, never>,
      HttpOutcome,
      HttpOutcome,
      never,
      typeof services
    >({
      name: 'hosted-image-generation.stage',
      execute: async (_facts, _next, env) => {
        const resolved = await services.directory.enumerateCandidates('gpt-image-2', 'image');
        return await env.spawnSubRun(imageGenerationSubPipeline, {
          'route.candidate': resolved.candidates[0] as RouteCandidate,
          'request.payload': { prompt: 'draw a camera' },
        });
      },
    }))
    .end(terminal<Record<never, never>, HttpOutcome, typeof services>({
      name: 'hosted-image-generation.end',
      execute: async () => {
        throw new Error('unreachable');
      },
    }));

  await withMockedFetch(
    () => jsonResponse({ data: [{ b64_json: 'aW1n' }] }),
    async () => {
      const outcome = await runPipeline(outer, {}, { services, traceSink: trace.sink });
      await readManagedBytes(outcome.body);
    },
  );

  const wire = projectWireView(trace.read());
  const attempt = wire.upstreamAttempts.find(candidate => candidate.isSubRun);
  expect(attempt?.request?.url).toMatchObject({
    origin: 'https://images.pipeline.example.com',
    pathname: '/v1/images/generations',
  });
  expect(attempt?.request?.body).toEqual({
    kind: 'json',
    value: { prompt: 'draw a camera', model: 'gpt-image-2' },
  });
  expect(attempt?.response?.status).toBe(200);
});
