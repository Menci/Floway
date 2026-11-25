import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { createOpenAIResponsesHttpStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { openAIResponsesHttpPipeline } from '../../../../src/data-plane/chat/openai-responses/pipeline/index.ts';
import { openAIResponsesServices } from '../../../../src/data-plane/chat/openai-responses/pipeline/services.ts';
import { servePipeline } from '../../../../src/data-plane/pipeline/host.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, sseResponse, testAdminUser, warmModelsForTest } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { withMockedFetch } from '@floway-dev/test-utils';

const model = 'responses-model';
const usage = { input_tokens: 4, output_tokens: 1, total_tokens: 5 };
const generation = openAIResponsesHttpPipeline('generate');
const compaction = openAIResponsesHttpPipeline('compact');

const setup = async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    flagOverrides: { 'openai-responses-compact-shim': false },
    config: {
      baseUrl: 'https://responses.example.com',
      apiKey: 'responses-upstream-key',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: model, endpoints: { openaiResponses: {} } }],
    },
  }));
  const app = new Hono<{ Variables: AuthVars }>();
  const mount = (path: string, pipeline: typeof generation): void => {
    app.post(path, c => {
      c.set('apiKey', apiKey);
      c.set('user', testAdminUser);
      return servePipeline(c, pipeline, input => openAIResponsesServices(
        input, (startedAt, store) => createOpenAIResponsesHttpStore(apiKey, startedAt, store), Date.now(),
      ));
    });
  };
  mount('/v1/responses', generation);
  mount('/v1/responses/compact', compaction);
  await warmModelsForTest();
  return {
    request: (path: string, payload: object) => app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: 'hello', ...payload }),
    }),
  };
};

const generated = {
  id: 'resp_upstream',
  object: 'response',
  model,
  status: 'completed',
  output: [],
  usage,
  error: null,
  incomplete_details: null,
} satisfies OpenAIResponsesResultEx;

const generatedResponse = () => sseResponse([
  { data: { type: 'response.created', sequence_number: 0, response: { ...generated, status: 'in_progress' } } },
  { data: { type: 'response.completed', sequence_number: 1, response: generated } },
  { data: '[DONE]' },
]);

test('OpenAI Responses generation streams upstream and persists the requested continuation', async () => {
  const { request } = await setup();
  const wire: unknown[] = [];
  await withMockedFetch(async upstream => {
    expect(new URL(upstream.url).pathname).toBe('/v1/responses');
    expect(upstream.headers.get('authorization')).toBe('Bearer responses-upstream-key');
    wire.push(await upstream.json());
    return generatedResponse();
  }, async () => {
    const response = await request('/v1/responses', { stream: false });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-reasoning-included')).toBe('true');
    const first = await response.json() as { id: string; created_at: number };
    expect(first.id).toMatch(/^resp_/);
    expect(first.id).not.toBe(generated.id);
    expect(first.created_at).toBeGreaterThan(0);
    const streamed = await request('/v1/responses', { stream: true, input: 'continue', previous_response_id: first.id });
    expect(streamed.status).toBe(200);
    const body = await streamed.text();
    expect(body).toContain('response.completed');
    expect(body).toContain(first.id);
    expect(body).toContain('data: [DONE]');
    expect(wire).toMatchObject([
      { stream: true, input: [{ type: 'message', role: 'user', content: 'hello' }] },
      { stream: true, input: [{ type: 'message', role: 'user', content: 'hello' }, { type: 'message', role: 'user', content: 'continue' }] },
    ]);
    expect(wire[1]).not.toHaveProperty('previous_response_id');
    await flushBackground();
  });
});

test('OpenAI Responses compact enters the scalar provider operation and completes the resource', async () => {
  const { request } = await setup();
  let upstreamCalls = 0;
  await withMockedFetch(async upstream => {
    upstreamCalls++;
    expect(new URL(upstream.url).pathname).toBe('/v1/responses/compact');
    const payload: unknown = await upstream.json();
    expect(payload).toEqual({ model, input: [{ type: 'message', role: 'user', content: 'hello' }] });
    return Response.json({ id: 'resp_compaction', object: 'response.compaction', output: [], usage }, {
      headers: { 'x-request-id': 'compaction-id' },
    });
  }, async () => {
    const response = await request('/v1/responses/compact', { store: false, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('compaction-id');
    expect(await response.json()).toMatchObject({
      object: 'response.compaction',
      output: [{ type: 'reasoning', encrypted_content: expect.any(String) }],
      usage,
      created_at: expect.any(Number),
    });
    expect(upstreamCalls).toBe(1);
    await flushBackground();
  });
});
