import { expect, test } from 'vitest';

import { decisionPipeline } from '../../../src/data-plane/decision/pipeline.ts';
import { GatewayRequestDirectory, createGatewayPipelineServices } from '../../../src/data-plane/pipeline/index.ts';
import type { Repo } from '../../../src/repo/types.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { createDumpDecoder, createDumpEncoder, defineStage, pipeline, projectWireView, runPipeline, terminal } from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import { parseJSONWithRawNumbers, type DecisionTarget, type ModelPricing } from '@floway-dev/protocols/common';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import type { HttpOutcome, ProviderPipelineDecisionOutcome } from '@floway-dev/provider';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const saveDecisionUpstream = async (
  repo: Repo,
  target: DecisionTarget,
  pricing?: ModelPricing,
): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_decision',
    name: 'Decision Provider',
    config: {
      baseUrl: 'https://decision.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-decision',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{
        upstreamModelId: 'raw-decision',
        publicModelId: 'public-decision',
        kind: 'decision',
        endpoints: { decision: {} },
        decisionTarget: target,
        ...(pricing === undefined ? {} : { pricing }),
      }],
    },
  }));
};

const requestHeaders = (apiKey: string) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
});

const choiceRequest = {
  model: 'public-decision',
  state: 'The API returns 500 on every call.',
  questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } },
};

test('/v1/systemone forwards a System One request and records input tokens', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'typesafe-systemone' }, { entries: [{ rates: { input_tokens: '0.000042' } }] });

  let upstreamRequest: Request | undefined;
  await withMockedFetch(
    async request => {
      upstreamRequest = request;
      return jsonResponse({
        model: 'microsoft-decision-1',
        answers: { team: { type: 'choice', choice: 'engineering', confidence: 0.9997532109087481, probabilities: { billing: 0.00012339454562592273, engineering: 0.9998766054543741 } } },
        usage: { input_tokens: 56, output_tokens: 1 },
      });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/systemone', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify(choiceRequest),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        model: 'microsoft-decision-1',
        answers: { team: { type: 'choice', choice: 'engineering', confidence: 0.9997532109087481, probabilities: { billing: 0.00012339454562592273, engineering: 0.9998766054543741 } } },
        usage: { input_tokens: 56, output_tokens: 1 },
      });
    },
  );

  assertExists(upstreamRequest);
  assertEquals(new URL(upstreamRequest.url).pathname, '/v1/systemone');
  assertEquals(await upstreamRequest.clone().json(), { ...choiceRequest, model: 'raw-decision' });

  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0].requests, 1);
  // Output tokens are free, so only the input quantity carries a rate.
  assertEquals(usage[0].metrics, [{ metric: 'input_tokens', quantity: '56', unitPrice: '0.000042' }]);
  const performance = await repo.performance.listAll();
  assertEquals(performance[0]?.operation, 'decision');
  assertEquals(performance[0]?.requests, 1);
});

test('/v1/decisions accepts the OpenAI shape and translates to a System One target', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'typesafe-systemone' });

  let upstreamRequest: Request | undefined;
  await withMockedFetch(
    async request => {
      upstreamRequest = request;
      return jsonResponse({
        model: 'microsoft-decision-1',
        answers: { team: { type: 'choice', choice: 'engineering', confidence: 0.99, probabilities: { billing: 0.01, engineering: 0.99 } } },
        usage: { input_tokens: 40, output_tokens: 1 },
      });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/decisions', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-decision',
          input: 'The API returns 500 on every call.',
          questions: [{
            type: 'choice',
            name: 'team',
            instructions: 'Which team?',
            choices: [{ value: 'billing', description: 'Charges' }, { value: 'engineering', description: 'Bugs' }],
          }],
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        model: 'microsoft-decision-1',
        answers: [{
          type: 'choice',
          name: 'team',
          choice: 'engineering',
          confidence: 0.99,
          probabilities: [{ value: 'billing', probability: 0.01 }, { value: 'engineering', probability: 0.99 }],
        }],
        usage: { input_tokens: 40, output_tokens: 1 },
      });
    },
  );

  assertExists(upstreamRequest);
  assertEquals(new URL(upstreamRequest.url).pathname, '/v1/systemone');
  assertEquals(await upstreamRequest.clone().json(), {
    model: 'raw-decision',
    state: 'The API returns 500 on every call.',
    questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } },
  });
});

test('/v1/decisions surfaces a cross-dialect upstream body it cannot parse', async () => {
  const { apiKey, repo } = await setupAppTest();
  // The client speaks OpenAI Decisions; the target speaks System One, so the
  // upstream body must be translated — an unparseable one cannot be forwarded.
  await saveDecisionUpstream(repo, { protocol: 'typesafe-systemone' });

  await withMockedFetch(
    () => new Response('upstream is unavailable', { status: 200, headers: { 'content-type': 'text/plain' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/decisions', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-decision',
          input: 'The API returns 500.',
          questions: [{ type: 'predicate', name: 'is_bug', instructions: 'Is this a bug?' }],
        }),
      });
      assertEquals(response.status, 502);
    },
  );
});

test('decisionPipeline projects raw-number request and rendered upstream values through Dump V2', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'typesafe-systemone' });
  await warmModelsForTest();
  const ctx = mockGatewayCtx({ apiKeyId: apiKey.id, backgroundScheduler: promise => { void promise; } });
  const directory = new GatewayRequestDirectory({
    user: ctx.user,
    upstreamIds: null,
    randomizeUpstreams: false,
    runtimeLocation: ctx.runtimeLocation,
    backgroundScheduler: ctx.backgroundScheduler,
  });
  await directory.ensureLoaded();
  const provider = directory.providerFor('up_decision');
  const upstreamBody = '{"model":"microsoft-decision-1","answers":{"is_bug":{"type":"noul","noul":1.0}},"usage":{"input_tokens":11}}';
  const providerPipe = pipeline<{ readonly 'request.model': string }>('provider.decision')
    .use(defineStage<{ readonly 'request.model': string }, Record<never, never>, HttpOutcome, ProviderPipelineDecisionOutcome>({
      name: 'gateway.decision.dispatch.contract',
      execute: async (_facts, next) => ({
        target: { protocol: 'typesafe-systemone' },
        modelKey: 'microsoft-decision-1',
        http: await next(),
      }),
    }))
    .end(terminal<Record<never, never>, HttpOutcome>({
      name: 'gateway.decision.http',
      tap: 'upstream',
      execute: async (_facts, env) => ({
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']],
        body: env.createStream({
          label: 'http.body',
          async *iterate() {
            yield new TextEncoder().encode(upstreamBody);
          },
        }),
        timing: { startedAtMs: 1, headersAtMs: 2 },
      }),
    }));
  Object.assign(provider, { pipelines: { ...provider.pipelines, decision: providerPipe } });

  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  const traceSink: RunTraceSink = {
    push: event => {
      for (const encoded of encoder.encodeBatch([event])) {
        chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`));
      }
    },
  };
  const rawRequestText = '{"model":"public-decision","state":{"reading":1.0},"questions":{"is_bug":{"type":"noul","instructions":"Is this a bug?"}}}';
  const rawRequestBody = parseJSONWithRawNumbers(rawRequestText);
  const parsed = parseDecisionRequest('typesafe-systemone', rawRequestBody);
  const outcome = await runPipeline(decisionPipeline('openai-decisions'), {
    'request.http': {
      method: 'POST',
      url: 'https://gateway.example/v1/decisions',
      headers: [],
      body: rawRequestBody,
      protocol: 'typesafe-systemone',
    },
    'request.inboundHeaders': [],
    'request.model': parsed.model,
    'request.payload': parsed.request,
  }, {
    services: createGatewayPipelineServices(ctx, { directory }),
    traceSink,
  });
  expect(new TextDecoder().decode(outcome.body as Uint8Array)).toContain('"probability":1.0');

  const decoder = createDumpDecoder();
  for (const chunk of chunks) decoder.pushNdjsonChunk(chunk);
  const wire = projectWireView(decoder.pushNdjsonChunk(new Uint8Array(), { final: true }));
  expect(JSON.stringify(wire.downstreamRequest?.body)).toContain('"reading":1.0');
  expect(wire.upstreamAttempts).toHaveLength(1);
  expect(wire.upstreamAttempts[0]?.response?.status).toBe(200);
  expect(wire.upstreamAttempts[0]?.response?.rawStreamId).toBeTypeOf('number');
  expect(new TextDecoder().decode(wire.upstreamAttempts[0]?.response?.rawFrames[0]?.value as Uint8Array)).toBe(upstreamBody);
  expect(wire.downstreamResponse?.status).toBe(200);
  expect(new TextDecoder().decode(wire.downstreamResponse?.body as Uint8Array)).toContain('"probability":1.0');
});
