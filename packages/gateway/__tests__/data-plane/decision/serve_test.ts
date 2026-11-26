import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import type { Repo } from '../../../src/repo/types.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import type { DecisionTarget, ModelPricing } from '@floway-dev/protocols/common';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const decisionUpstream = (
  target: DecisionTarget,
  pricing?: ModelPricing,
  identity = { id: 'up_decision', baseUrl: 'https://decision.example.com', sortOrder: 0 },
) =>
  buildCustomUpstreamRecord({
    id: identity.id,
    name: 'Decision Provider',
    sortOrder: identity.sortOrder,
    config: {
      baseUrl: identity.baseUrl,
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
  });

const saveDecisionUpstream = async (repo: Repo, target: DecisionTarget, pricing?: ModelPricing): Promise<void> => {
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, decisionUpstream(target, pricing));
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

test.each(['invalid JSON', '{"model":"public-decision"}'])('/v1/systemone rejects invalid ingress %s', async body => {
  const { apiKey } = await setupAppTest();
  const response = await requestAppWithWarmModels('/v1/systemone', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body,
  });
  assertEquals(response.status, 400);
});

test('/v1/systemone forwards a System One request and records input tokens', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'typesafe-systemone' }, { entries: [{ rates: { input_tokens: '0.000042' } }] });

  let upstreamRequest: Request | undefined;
  await withMockedFetch(
    async request => {
      upstreamRequest = request;
      const body = JSON.stringify({
        model: 'microsoft-decision-1',
        answers: { team: { type: 'choice', choice: 'engineering', confidence: 0.9997532109087481, probabilities: { billing: 0.00012339454562592273, engineering: 0.9998766054543741 } } },
        usage: { input_tokens: 56, output_tokens: 1 },
      });
      return new Response(new TextEncoder().encode(body));
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/systemone', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify(choiceRequest),
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'application/json');
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

test('/v1/systemone archives the selected refusal and retains its usage without calling another candidate', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await saveDecisionUpstream(repo, { protocol: 'openai-decisions' }, { entries: [{ rates: { input_tokens: '0.000042' } }] });
  await saveUpstreamForTest(repo.upstreams, decisionUpstream({ protocol: 'typesafe-systemone' }, undefined, {
    id: 'up_decision_next', baseUrl: 'https://next-decision.example.com', sortOrder: 100,
  }));
  const archive = installDumpStubs(initDumpStore, initDumpBroker);
  const calls: string[] = [];

  await withMockedFetch(
    request => {
      const { hostname } = new URL(request.url);
      calls.push(hostname);
      if (hostname === 'decision.example.com') {
        return new Response(JSON.stringify({
          model: 'raw-decision',
          answers: [{ type: 'refusal', name: 'team' }],
          usage: { input_tokens: 3 },
        }), { headers: { 'content-type': 'application/json', 'x-provider-trace': 'decision-refusal' } });
      }
      assertEquals(hostname, 'next-decision.example.com');
      return jsonResponse({
        answers: { team: { type: 'choice', choice: 'engineering', confidence: 1, probabilities: { billing: 0, engineering: 1 } } },
      });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/systemone', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify(choiceRequest),
      });
      assertEquals(calls, ['decision.example.com']);
      assertEquals(response.status, 502);
      assertEquals(response.headers.get('x-provider-trace'), 'decision-refusal');
      assertEquals(await response.json(), {
        error: { type: 'api_error', message: 'answers.team is a refusal, which System One cannot express' },
      });
    },
  );
  await flushAsyncWork();

  assertEquals(archive.published.length, 1);
  assertEquals(archive.published[0]?.meta.status, 502);
  assertEquals(archive.published[0]?.meta.upstream?.id, 'up_decision');
  assertEquals(archive.published[0]?.meta.error, { kind: 'upstream' });
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.length, 1);
  const [usage] = usageRows;
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, [{ metric: 'input_tokens', quantity: '3', unitPrice: '0.000042' }]);
  const performanceRows = await repo.performance.listAll();
  assertEquals(performanceRows.length, 1);
  const [performance] = performanceRows;
  assertEquals(performance.requests, 1);
  assertEquals(performance.neutral, 1);
  assertEquals(performance.errorsNoOutput, 0);
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
