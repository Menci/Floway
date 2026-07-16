import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountCodexRoutes } from './routes.ts';
import { type AuthVars, authMiddleware } from '../../middleware/auth.ts';
import { copilotModels, setupAppTest } from '../../test-helpers.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildCodexApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', authMiddleware);
  mountCodexRoutes(app);
  return app;
};

const copilotFetch = (models: Array<{ id: string; maxContextWindowTokens?: number; supported_endpoints?: string[] }>) =>
  (request: Request): Response => {
    const url = new URL(request.url);
    if (url.hostname === 'update.code.visualstudio.com') {
      return jsonResponse(['1.110.1']);
    }
    if (url.pathname === '/copilot_internal/v2/token') {
      return jsonResponse({ token: 'test-copilot-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
    }
    if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
      return jsonResponse(copilotModels(models));
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  };

interface CodexModelsResponse {
  models: Array<{
    slug: string;
    context_window?: number;
    max_context_window?: number;
    auto_compact_token_limit?: number | null;
  }>;
}

describe('Codex model-provider routes', () => {
  it('owns the namespaced alpha-search path', async () => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request('/azure-api.codex/alpha/search', {
      method: 'POST',
      body: JSON.stringify({ commands: {} }),
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: expect.stringContaining('No web search commands were provided') });
  });

  it.each(['/alpha/search', '/v1/alpha/search'])('does not mount the general alpha-search alias %s', async path => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request(path, {
      method: 'POST',
      body: JSON.stringify({ commands: {} }),
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    });

    expect(response.status).toBe(404);
  });

  it.each([
    { method: 'GET', path: '/azure-api.codex/wham/agent-identities/jwks' },
    { method: 'POST', path: '/azure-api.codex/codex/analytics-events/events' },
    { method: 'POST', path: '/azure-api.codex/api/codex/apps' },
    { method: 'GET', path: '/azure-api.codex/plugins/featured' },
    { method: 'GET', path: '/azure-api.codex/plugins/list' },
    { method: 'GET', path: '/azure-api.codex/ps/plugins/list' },
    { method: 'GET', path: '/azure-api.codex/ps/plugins/installed' },
  ])('does not emulate the account-backed route $path', async ({ method, path }) => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request(path, {
      method,
      headers: { authorization: `Bearer ${apiKey.key}` },
    });

    expect(response.status).toBe(404);
  });

  it('mounts the Responses WebSocket transport at the provider-relative path', async () => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request('/azure-api.codex/responses', {
      headers: { authorization: `Bearer ${apiKey.key}` },
    });

    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({ error: 'Expected Upgrade: websocket' });
  });

  it('writes both context-window fields from the registry and leaves automatic compaction at the Codex default', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
      async () => {
        const response = await buildCodexApp().request('/azure-api.codex/models', {
          headers: { authorization: `Bearer ${apiKey.key}` },
        });
        expect(response.status).toBe(200);
        return await response.json() as CodexModelsResponse;
      },
    );

    expect(body.models.find(model => model.slug === 'gpt-5.5')).toMatchObject({
      context_window: 1050000,
      max_context_window: 1050000,
      auto_compact_token_limit: null,
    });
  });

  it('downgrades a bundled maximum when the registry advertises a smaller limit', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'gpt-5.4', maxContextWindowTokens: 272000 }]),
      async () => {
        const response = await buildCodexApp().request('/azure-api.codex/models', {
          headers: { authorization: `Bearer ${apiKey.key}` },
        });
        expect(response.status).toBe(200);
        return await response.json() as CodexModelsResponse;
      },
    );

    const model = body.models.find(candidate => candidate.slug === 'gpt-5.4');
    expect(model?.context_window).toBe(272000);
    expect(model?.max_context_window).toBe(272000);
  });

  it('emits only bundled entries resolved from registry models', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
      async () => await (await buildCodexApp().request('/azure-api.codex/models', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      })).json() as CodexModelsResponse,
    );

    expect(body.models.map(model => model.slug)).toEqual(['gpt-5.5']);
  });

  it('synthesizes catalog metadata for registry chat models without a bundled match', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'claude-sonnet-4', supported_endpoints: ['/v1/messages'] }]),
      async () => await (await buildCodexApp().request('/azure-api.codex/models', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      })).json() as CodexModelsResponse,
    );

    expect(body.models).toHaveLength(1);
    expect(body.models[0].slug).toBe('claude-sonnet-4');
  });
});
