import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../../../repo/upstreams.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, copilotModels, requestAppWithWarmModels, setupAppTest, sseResponse } from '../../../../test-utils/app.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { withMockedFetch } from '@floway-dev/test-utils';

const model = 'gpt-test';

const result = (output: OpenAIResponsesOutputItemEx[], status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_raw',
  object: 'response',
  model,
  output,
  status,
  error: null,
  incomplete_details: null,
});

test('Copilot item-id and generic affinity trailers compose and unwrap in boundary order', async () => {
  const { apiKey, githubAccount, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCopilotUpstreamRecord(githubAccount, {
    id: 'up-copilot-affinity',
    state: {
      copilotToken: {
        token: 'copilot-token',
        expiresAt: Date.now() + 3_600_000,
        baseUrl: 'https://api.individual.githubcopilot.com',
      },
    },
  }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: {
      baseUrl: 'https://other.example.com', apiKey: 'other-key',
      endpoints: { openaiResponses: {} }, ingressHeadersRules: [],
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: model, endpoints: { openaiResponses: {} } }],
    },
    modelPrefix: { prefix: 'other/', addressable: ['prefixed'], listed: ['prefixed'] },
  }));

  const rawReasoning: OpenAIResponsesOutputItemEx = {
    type: 'reasoning',
    id: 'rs_raw',
    summary: [],
    encrypted_content: 'opaque reasoning',
  };
  const requests: { hostname: string; input: CanonicalOpenAIResponsesPayload['input'] }[] = [];
  const send = async (target: string, input: CanonicalOpenAIResponsesPayload['input']): Promise<string> => {
    const response = await requestAppWithWarmModels('/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: target, input, stream: true, store: false }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return body;
  };

  await withMockedFetch(async request => {
    const url = new URL(request.url);
    if (url.pathname === '/models') return Response.json(copilotModels([{ id: model, supported_endpoints: ['/responses'] }]));
    if (url.hostname === 'update.code.visualstudio.com') return Response.json(['1.110.1']);
    if (url.pathname !== '/responses' && url.pathname !== '/v1/responses') throw new Error(`Unhandled fetch ${request.url}`);
    const body = await request.json() as CanonicalOpenAIResponsesPayload;
    requests.push({ hostname: url.hostname, input: body.input });
    if (requests.length === 1) {
      return sseResponse([
        { data: { type: 'response.created', response: result([], 'in_progress') } },
        { data: { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_added', summary: [] } } },
        { data: { type: 'response.output_item.done', output_index: 0, item: rawReasoning } },
        { data: { type: 'response.completed', response: result([rawReasoning], 'completed') } },
        { data: '[DONE]' },
      ]);
    }
    return sseResponse([
      { data: { type: 'response.completed', response: result([], 'completed') } },
      { data: '[DONE]' },
    ]);
  }, async () => {
    const wire = await send(model, []);
    const done = wire.split('\n').filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)) as OpenAIResponsesStreamEventEx)
      .find(event => event.type === 'response.output_item.done');
    if (done?.item.type !== 'reasoning') throw new Error('Expected public reasoning item');
    expect(done.item.id).toMatch(/^rs_[0-9a-f]{32}$/);
    expect(done.item.encrypted_content).not.toBe(rawReasoning.encrypted_content);

    await send(model, [done.item]);
    await send(`other/${model}`, [done.item]);
  });

  expect(requests).toEqual([
    { hostname: 'api.individual.githubcopilot.com', input: [] },
    { hostname: 'api.individual.githubcopilot.com', input: [rawReasoning] },
    { hostname: 'other.example.com', input: [] },
  ]);
});
