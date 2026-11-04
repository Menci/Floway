import { describe, test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { copilotModels, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const DECISION_MODEL = 'microsoft-decision-1';

// Shape captured from Copilot `/v1/systemone` on 2026-11-04.
const SYSTEM_ONE_RESPONSE = {
  model: DECISION_MODEL,
  answers: {
    owner: {
      type: 'choice',
      choice: 'frontend',
      confidence: 0.9995,
      probabilities: { backend: 0.0001, frontend: 0.9997, unknown: 0.0002 },
    },
  },
  usage: { input_tokens: 136, output_tokens: 3 },
};

const DECISIONS_REQUEST = {
  model: DECISION_MODEL,
  input: 'The export button does nothing and the Network panel shows no request.',
  questions: [{
    type: 'choice',
    name: 'owner',
    instructions: 'Which team should investigate first?',
    choices: [
      { value: 'frontend', description: 'Browser interaction or client script failures' },
      { value: 'backend', description: 'The request was sent and the server failed' },
      { value: 'unknown', description: 'Not enough evidence' },
    ],
  }],
};

interface UpstreamCall {
  path: string;
  body: unknown;
}

const withCopilotDecisionUpstream = async (
  systemOne: () => Response,
  run: (calls: UpstreamCall[]) => Promise<void>,
): Promise<void> => {
  const calls: UpstreamCall[] = [];
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.enterprise.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([
          { id: DECISION_MODEL, supported_endpoints: ['/v1/systemone'] },
          { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
        ]));
      }
      calls.push({ path: url.pathname, body: await request.json() });
      if (url.pathname === '/v1/systemone') return systemOne();
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    () => run(calls),
  );
};

const post = (path: string, apiKey: string, body: unknown): Promise<Response> =>
  requestAppWithWarmModels(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });

describe('OpenAI Decisions route', () => {
  test.each(['/v1/decisions', '/decisions'])('%s lowers onto Copilot System One and renders OpenAI answers', async path => {
    const { apiKey, repo } = await setupAppTest();

    await withCopilotDecisionUpstream(() => jsonResponse(SYSTEM_ONE_RESPONSE), async calls => {
      const response = await post(path, apiKey.key, DECISIONS_REQUEST);

      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        model: DECISION_MODEL,
        answers: [{
          type: 'choice',
          name: 'owner',
          choice: 'frontend',
          confidence: 0.9995,
          probabilities: [
            { value: 'frontend', probability: 0.9997 },
            { value: 'backend', probability: 0.0001 },
            { value: 'unknown', probability: 0.0002 },
          ],
        }],
        usage: { input_tokens: 136, output_tokens: 3, total_tokens: 139 },
      });
      assertEquals(calls, [{
        path: '/v1/systemone',
        body: {
          state: DECISIONS_REQUEST.input,
          questions: {
            owner: {
              type: 'choice',
              instructions: 'Which team should investigate first?',
              criteria: {
                frontend: 'Browser interaction or client script failures',
                backend: 'The request was sent and the server failed',
                unknown: 'Not enough evidence',
              },
            },
          },
          model: DECISION_MODEL,
        },
      }]);
    });

    await flushAsyncWork();
    const usage = await repo.usage.listAll();
    assertEquals(usage.length, 1);
    assertEquals(usage[0].model, DECISION_MODEL);
    assertEquals(tokenCountsFromUsage(usage[0]), { input: 136, output: 3 });
    const performance = await repo.performance.listAll();
    assertEquals(performance.map(row => [row.operation, row.requests, row.errorsNoOutput]), [['decision', 1, 0]]);
  });

  test('rejects an unrepresentable request with an OpenAI invalid_request_error before any upstream call', async () => {
    const { apiKey } = await setupAppTest();

    await withCopilotDecisionUpstream(() => jsonResponse(SYSTEM_ONE_RESPONSE), async calls => {
      const response = await post('/v1/decisions', apiKey.key, {
        ...DECISIONS_REQUEST,
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/a.png' }] }],
      });

      assertEquals(response.status, 400);
      assertEquals(await response.json(), {
        error: {
          message: 'System One decision models cannot represent input_image parts.',
          type: 'invalid_request_error',
          param: 'input[0].content[0]',
        },
      });
      assertEquals(calls, []);
    });
  });

  test('forwards an upstream failure verbatim', async () => {
    const { apiKey, repo } = await setupAppTest();
    const upstreamError = { detail: 'invalid TypeSafe request: invalid criteria for question "owner"' };

    await withCopilotDecisionUpstream(() => new Response(JSON.stringify(upstreamError), { status: 422, headers: { 'content-type': 'application/json', 'x-github-request-id': 'req-1' } }), async () => {
      const response = await post('/v1/decisions', apiKey.key, DECISIONS_REQUEST);

      assertEquals(response.status, 422);
      assertEquals(response.headers.get('x-github-request-id'), 'req-1');
      assertEquals(await response.json(), upstreamError);
    });

    await flushAsyncWork();
    assertEquals(await repo.usage.listAll(), []);
  });

  test('reports a 2xx answer map it cannot render as an internal failure but still bills the tokens', async () => {
    const { apiKey, repo } = await setupAppTest();

    await withCopilotDecisionUpstream(() => jsonResponse({ ...SYSTEM_ONE_RESPONSE, answers: {} }), async () => {
      const response = await post('/v1/decisions', apiKey.key, DECISIONS_REQUEST);

      assertEquals(response.status, 502);
      const body = await response.json() as { error: { message: string } };
      assertEquals(body.error.message.includes('answer "owner"'), true);
    });

    await flushAsyncWork();
    const usage = await repo.usage.listAll();
    assertEquals(usage.map(row => tokenCountsFromUsage(row)), [{ input: 136, output: 3 }]);
  });

  test('rejects a chat model and an unknown model', async () => {
    const { apiKey } = await setupAppTest();

    await withCopilotDecisionUpstream(() => jsonResponse(SYSTEM_ONE_RESPONSE), async calls => {
      const chat = await post('/v1/decisions', apiKey.key, { ...DECISIONS_REQUEST, model: 'gpt-chat' });
      assertEquals(chat.status, 400);
      assertEquals(((await chat.json()) as { error: { message: string } }).error.message, 'Model gpt-chat does not support the /decisions endpoint.');

      const unknown = await post('/v1/decisions', apiKey.key, { ...DECISIONS_REQUEST, model: 'missing-model' });
      assertEquals(unknown.status, 404);
      assertEquals(calls, []);
    });
  });
});

describe('System One route', () => {
  test.each(['/v1/systemone', '/systemone'])('%s forwards the request and response verbatim apart from the model id', async path => {
    const { apiKey, repo } = await setupAppTest();
    const request = {
      model: DECISION_MODEL,
      state: { message: 'checkout down', count: 3 },
      questions: { urgent: { type: 'noul', instructions: 'Is it urgent?', criteria: { true: 'blocks users', false: 'cosmetic' } } },
      extension: { kept: true },
    };
    const upstream = { model: DECISION_MODEL, answers: { urgent: { type: 'noul', noul: 0.77 } }, usage: { input_tokens: 28, output_tokens: 1 }, extra: 'kept' };

    await withCopilotDecisionUpstream(() => jsonResponse(upstream), async calls => {
      const response = await post(path, apiKey.key, request);

      assertEquals(response.status, 200);
      assertEquals(await response.json(), upstream);
      assertEquals(calls, [{ path: '/v1/systemone', body: request }]);
    });

    await flushAsyncWork();
    const usage = await repo.usage.listAll();
    assertEquals(usage.map(row => tokenCountsFromUsage(row)), [{ input: 28, output: 1 }]);
  });
});
