import { expect, test } from 'vitest';

import { createGatewayPipelineServices } from '../../../../../src/data-plane/pipeline/services.ts';
import type { GatewayPipelineServices } from '../../../../../src/data-plane/pipeline/services.ts';
import { alphaSearchPassthroughSubPipeline } from '../../../../../src/data-plane/tools/web-search/pipeline.ts';
import { mockGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import {
  createDumpDecoder,
  createDumpEncoder,
  defineStage,
  pipeline,
  runPipeline,
  terminal,
} from '@floway-dev/pipeline';
import type { RunTraceSink, WireRequestSnapshot } from '@floway-dev/pipeline';
import type { HttpOutcome, ProviderPipelineAlphaSearchInput, ProviderPipelineServices, RouteCandidate } from '@floway-dev/provider';
import { asyncIterableToReadableStream, headersFromEntries, toProviderModelFacts } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const candidate = (): RouteCandidate => Object.freeze({
  upstreamId: 'up_alpha',
  upstreamName: 'Alpha',
  kind: 'custom',
  modelId: 'search-model',
  upstreamModelId: 'search-model',
  endpoints: Object.freeze({ openaiResponses: {} }),
  limits: Object.freeze({}),
  providerModel: toProviderModelFacts(stubProviderModel({
    id: 'search-model',
    upstreamModelId: 'search-model',
    endpoints: { openaiResponses: {} },
  })),
});

const providerPipeline = pipeline<ProviderPipelineAlphaSearchInput>('alpha-provider')
  .use(defineStage<ProviderPipelineAlphaSearchInput, Record<never, never>, HttpOutcome, HttpOutcome, never, ProviderPipelineServices>({
    name: 'alpha-provider.request',
    execute: async (_facts, _next, env) => ({
      status: 200,
      statusText: 'OK',
      headers: [['content-type', 'application/json']],
      body: env.createStream({
        async *iterate() {
          yield new TextEncoder().encode(JSON.stringify({ encrypted_output: null, output: 'sub-run output' }));
        },
      }),
      timing: { startedAtMs: 0, headersAtMs: 1 },
    }),
  }))
  .end(terminal<ProviderPipelineAlphaSearchInput, HttpOutcome, ProviderPipelineServices>({
    name: 'unreachable',
    execute: async () => ({ status: 500, statusText: 'Internal Server Error', headers: [], body: null, timing: { startedAtMs: 0, headersAtMs: 0 } }),
  }));

test('alpha-search passthrough records its provider pipeline as a sub-run', async () => {
  const route = candidate();
  const base = createGatewayPipelineServices(mockGatewayCtx());
  const services: GatewayPipelineServices = {
    ...base,
    providerFor: (upstreamId: string) => ({
      upstreamId,
      name: 'Alpha',
      kind: 'custom' as const,
      pipelines: { alphaSearch: providerPipeline },
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: {} as never,
      configVersion: 1,
      modelsRefreshInputHash: '',
    }),
  };
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  const traceSink: RunTraceSink = {
    push: event => {
      for (const encoded of encoder.encodeBatch([event])) {
        chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`));
      }
    },
  };
  const parent = pipeline<{ readonly 'request.http': WireRequestSnapshot }>('alpha-route')
    .use(defineStage<{ readonly 'request.http': WireRequestSnapshot }, Record<never, never>, HttpOutcome, HttpOutcome, never, typeof services>({
      name: 'alpha-route.execute',
      execute: async (_facts, _next, env) => await env.spawnSubRun(alphaSearchPassthroughSubPipeline, {
        'route.candidate': route,
        'request.payload': { commands: {} },
        'request.inboundHeaders': [],
      }),
    }))
    .end(terminal<{ readonly 'request.http': WireRequestSnapshot }, HttpOutcome, typeof services>({
      name: 'unreachable',
      execute: async () => ({ status: 500, statusText: 'Internal Server Error', headers: [], body: null, timing: { startedAtMs: 0, headersAtMs: 0 } }),
    }));

  const result = await runPipeline(parent, {
    'request.http': { method: 'POST', url: 'https://gateway.example/alpha/search', headers: [], body: {} },
  }, { services, traceSink });
  expect(result.status).toBe(200);
  expect(result.body).not.toBeNull();
  expect(await new Response(asyncIterableToReadableStream(result.body!), {
    headers: headersFromEntries(result.headers),
  }).json()).toEqual({ encrypted_output: null, output: 'sub-run output' });

  const decoder = createDumpDecoder();
  for (const chunk of chunks) decoder.pushNdjsonChunk(chunk);
  const model = decoder.pushNdjsonChunk(new Uint8Array(), { final: true });
  const stages = [...model.stages.values()];
  expect(stages.some(stage => stage.name === 'alpha-search.dispatch')).toBe(true);
  const subrunRoot = stages.find(stage => stage.edgeKind === 'subrun');
  expect(subrunRoot?.name).toBe('alpha-search.dispatch');
  expect(stages.some(stage => stage.name === 'alpha-provider.request' && stage.edgeKind === 'dispatch')).toBe(true);
});
