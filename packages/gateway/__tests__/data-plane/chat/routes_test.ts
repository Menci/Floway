import { expect, test } from 'vitest';

import { buildCustomUpstreamRecord, requestApp, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { withMockedFetch } from '@floway-dev/test-utils';

test.each([
  {
    operation: 'openaiChatCompletions',
    clientPath: '/chat/completions',
    upstreamPath: '/v1/chat/completions',
    payload: { model: 'model', messages: [{ role: 'user', content: 'hello' }] },
  },
  {
    operation: 'anthropicMessages',
    clientPath: '/messages',
    upstreamPath: '/v1/messages',
    payload: { model: 'model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] },
  },
  ...['generateContent', 'streamGenerateContent'].map(action => ({
    operation: 'geminiGenerateContent',
    clientPath: `/v1beta/models/model:${action}`,
    upstreamPath: '/v1beta/models/native-model:streamGenerateContent',
    payload: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
  })),
])('mounts $clientPath on its generation pipeline and preserves the upstream failure', async ({ operation, clientPath, upstreamPath, payload }) => {
  const { apiKey } = await setupAppTest({
    copilotUpstream: buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://upstream.test', apiKey: '', ingressHeadersRules: [], endpoints: { [operation]: {} },
        modelsFetch: { enabled: false, authStyle: 'bearer' },
        models: [{ upstreamModelId: 'native-model', publicModelId: 'model', endpoints: { [operation]: {} } }],
      },
    }),
  });
  const failure = { error: { code: 429, message: 'upstream quota exhausted', status: 'RESOURCE_EXHAUSTED' } };
  const dispatched: string[] = [];
  await withMockedFetch(request => {
    const url = new URL(request.url);
    dispatched.push(url.pathname);
    if (operation === 'geminiGenerateContent') expect(url.searchParams.get('alt')).toBe('sse');
    return Response.json(failure, { status: 429, headers: { 'x-upstream-trace': 'quota' } });
  }, async () => {
    const response = await requestAppWithWarmModels(clientPath, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('x-upstream-trace')).toBe('quota');
    expect(await response.json()).toEqual(failure);
  });
  expect(dispatched).toEqual([upstreamPath]);
});

test.each(['%ZZ', '%E0%A4%A'])('returns a Gemini action error for malformed percent encoding %s', async encoded => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp(`/v1beta/models/model${encoded}:unknownAction`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    body: '{}',
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ error: { code: 404, status: 'NOT_FOUND', message: 'Unknown Gemini model action: unknownAction' } });
});
