import { test } from 'vitest';

import { fetchCopilotModels } from './fetch-models.ts';
import { clearCopilotTokenCache } from '../../../shared/copilot.ts';
import { createCopilotUpstream } from '../../../shared/upstream/copilot.ts';
import { assertEquals } from '../../../test-assert.ts';
import { jsonResponse, setupAppTest, withMockedFetch } from '../../../test-helpers.ts';
import { ProviderModelsUnavailableError } from '../models-store.ts';

const copilotTokenResponse = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
  }
  return null;
};

test('fetchCopilotModels returns the parsed response on 2xx', async () => {
  const { githubAccount } = await setupAppTest();
  await clearCopilotTokenCache();
  const upstream = createCopilotUpstream('up_copilot', 'GitHub Copilot', githubAccount.token, 'individual');

  await withMockedFetch(
    request => {
      const preflight = copilotTokenResponse(request);
      if (preflight) return preflight;
      const url = new URL(request.url);
      if (url.pathname === '/models') return jsonResponse({ object: 'list', data: [{ id: 'cm-1' }] });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const result = await fetchCopilotModels(upstream);
      assertEquals(result.data[0].id, 'cm-1');
    },
  );
});

test('fetchCopilotModels throws ProviderModelsUnavailableError with httpResponse on non-2xx', async () => {
  const { githubAccount } = await setupAppTest();
  await clearCopilotTokenCache();
  const upstream = createCopilotUpstream('up_copilot', 'GitHub Copilot', githubAccount.token, 'individual');

  let thrown: unknown;
  await withMockedFetch(
    request => {
      const preflight = copilotTokenResponse(request);
      if (preflight) return preflight;
      const url = new URL(request.url);
      if (url.pathname === '/models') return new Response('forbidden', { status: 403 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      try { await fetchCopilotModels(upstream); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse?.status, 403);
  assertEquals(thrown.httpResponse?.body, 'forbidden');
});

test('fetchCopilotModels throws ProviderModelsUnavailableError with null httpResponse on shape error', async () => {
  const { githubAccount } = await setupAppTest();
  await clearCopilotTokenCache();
  const upstream = createCopilotUpstream('up_copilot', 'GitHub Copilot', githubAccount.token, 'individual');

  let thrown: unknown;
  await withMockedFetch(
    request => {
      const preflight = copilotTokenResponse(request);
      if (preflight) return preflight;
      const url = new URL(request.url);
      if (url.pathname === '/models') return jsonResponse({ object: 'list', data: [{ name: 'missing id' }] });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      try { await fetchCopilotModels(upstream); } catch (e) { thrown = e; }
    },
  );
  if (!(thrown instanceof ProviderModelsUnavailableError)) throw new Error('expected ProviderModelsUnavailableError');
  assertEquals(thrown.httpResponse, null);
});

test('fetchCopilotModels tags the request with the model-access intent and omits content-type', async () => {
  const { githubAccount } = await setupAppTest();
  await clearCopilotTokenCache();
  const upstream = createCopilotUpstream('up_copilot', 'GitHub Copilot', githubAccount.token, 'individual');

  let observed: Headers | undefined;
  await withMockedFetch(
    request => {
      const preflight = copilotTokenResponse(request);
      if (preflight) return preflight;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        observed = request.headers;
        return jsonResponse({ object: 'list', data: [{ id: 'cm-1' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      await fetchCopilotModels(upstream);
    },
  );

  if (!observed) throw new Error('expected /models fetch to have been observed');
  assertEquals(observed.get('openai-intent'), 'model-access');
  assertEquals(observed.get('x-interaction-type'), 'model-access');
  assertEquals(observed.get('content-type'), null);
});
