import { test } from 'vitest';

import type { Repo } from '../../../src/repo/types.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import type { DecisionTarget, ModelPricing } from '@floway-dev/protocols/common';
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
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-decision',
      endpoints: {},
      modelsFetch: { enabled: false },
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

const openAIShape = {
  model: 'public-decision',
  input: 'The API returns 500.',
  questions: [{ type: 'predicate', name: 'is_bug', instructions: 'Is this a bug?' }],
};

test('/v1/systemone forwards a System One request and records input tokens', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'systemone' }, { entries: [{ rates: { input_tokens: '0.000042' } }] });

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

test('a target that declares only choice refuses a noul question before dispatch', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'systemone', questionTypes: ['choice'] });

  let called = false;
  await withMockedFetch(
    () => {
      called = true;
      return jsonResponse({});
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/systemone', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-decision',
          state: 'I want a refund.',
          questions: { refund: { type: 'noul', instructions: 'Is a refund requested?' } },
        }),
      });
      assertEquals(response.status, 400);
      const body = await response.json() as { error: { message: string } };
      assertEquals(body.error.message.includes('noul questions'), true);
    },
  );

  assertEquals(called, false);
});

test('/v1/systemone rejects an unknown model with 404 and a wrong-kind model with 400', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'systemone' });

  const missing = await requestAppWithWarmModels('/v1/systemone', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body: JSON.stringify({ ...choiceRequest, model: 'nope' }),
  });
  assertEquals(missing.status, 404);

  const wrongKind = await requestAppWithWarmModels('/v1/systemone', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body: JSON.stringify({ ...choiceRequest, model: 'public-chat' }),
  });
  assertEquals(wrongKind.status, 404);
});

test('/v1/systemone rejects a malformed body before any upstream call', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'systemone' });

  const response = await requestAppWithWarmModels('/v1/systemone', {
    method: 'POST',
    headers: requestHeaders(apiKey.key),
    body: JSON.stringify({ ...choiceRequest, stream: true }),
  });
  assertEquals(response.status, 400);
});

test('/v1/decisions accepts the OpenAI shape and translates to a System One target', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'systemone' });

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

test('/v1/decisions forwards opaquely to a target on the same dialect', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'openai-decisions' });

  const sent = { ...openAIShape, model: 'raw-decision' };
  let upstreamRequest: Request | undefined;
  await withMockedFetch(
    async request => {
      upstreamRequest = request;
      return jsonResponse({
        model: 'gpt-6-luna',
        answers: [{ type: 'predicate', name: 'is_bug', probability: 0.92 }],
        usage: { input_tokens: 12, output_tokens: 0 },
      });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/decisions', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify(openAIShape),
      });
      assertEquals(response.status, 200);
      // Same dialect, so the upstream body is forwarded unchanged.
      assertEquals(await response.json(), {
        model: 'gpt-6-luna',
        answers: [{ type: 'predicate', name: 'is_bug', probability: 0.92 }],
        usage: { input_tokens: 12, output_tokens: 0 },
      });
    },
  );

  assertExists(upstreamRequest);
  assertEquals(await upstreamRequest.clone().json(), sent);
});

test('/v1/decisions refuses image evidence for a text-only target before dispatch', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'systemone' });

  let called = false;
  await withMockedFetch(
    () => {
      called = true;
      return jsonResponse({});
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/decisions', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-decision',
          input: [{
            role: 'user', content: [
              { type: 'input_text', text: 'Inspect this.' },
              { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
            ],
          }],
          questions: [{ type: 'predicate', name: 'damaged', instructions: 'Is it damaged?' }],
        }),
      });
      assertEquals(response.status, 400);
      const body = await response.json() as { error: { message: string } };
      assertEquals(body.error.message.includes('image evidence'), true);
    },
  );

  assertEquals(called, false);
});

test('/v1/decisions forwards image evidence when the target reads images', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveDecisionUpstream(repo, { protocol: 'openai-decisions', images: true });

  let upstreamRequest: Request | undefined;
  await withMockedFetch(
    async request => {
      upstreamRequest = request;
      return jsonResponse({ answers: [{ type: 'predicate', name: 'damaged', probability: 0.88 }], usage: { input_tokens: 90 } });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/decisions', {
        method: 'POST',
        headers: requestHeaders(apiKey.key),
        body: JSON.stringify({
          model: 'public-decision',
          input: [{
            role: 'user', content: [
              { type: 'input_text', text: 'Inspect this.' },
              { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
            ],
          }],
          questions: [{ type: 'predicate', name: 'damaged', instructions: 'Is it damaged?' }],
        }),
      });
      assertEquals(response.status, 200);
    },
  );

  assertExists(upstreamRequest);
  const sent = await upstreamRequest.clone().json() as { input: readonly { content: readonly Record<string, unknown>[] }[] };
  assertEquals(sent.input[0].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' });
});
