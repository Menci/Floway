import { test } from 'vitest';

import { assertEquals } from '../../test-assert.ts';
import { copilotModels, jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../test-helpers.ts';

test('/v1/images/generations rejects non-JSON body with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: 'not json',
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations rejects body without model with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations 404s when no upstream provides the model', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'no-such-model', prompt: 'hi' }),
      });
      assertEquals(response.status, 404);
    },
  );
});

test('/v1/images/edits rejects non-multipart body with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: '{}',
  });
  assertEquals(response.status, 400);
});

test('/v1/images/edits rejects multipart body without model field with 400', async () => {
  const { apiKey } = await setupAppTest();
  const form = new FormData();
  form.append('prompt', 'hi');
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key },
    body: form,
  });
  assertEquals(response.status, 400);
});
