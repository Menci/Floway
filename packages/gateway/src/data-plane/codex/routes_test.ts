import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountCodexRoutes } from './routes.ts';
import { authMiddleware } from '../../middleware/auth.ts';
import { copilotModels, setupAppTest } from '../../test-helpers.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildCodexApp = () => {
  const app = new Hono();
  app.use('*', authMiddleware);
  mountCodexRoutes(app);
  return app;
};

// Copilot models-list responder seeded with whatever slugs/limits the test
// wants the registry to advertise. Other Copilot endpoints (token mint,
// editor version) are answered with the canned shapes that every
// withMockedFetch caller expects.
const copilotFetch = (models: Array<{ id: string; maxContextWindowTokens?: number; supported_endpoints?: string[] }>) =>
  (request: Request): Response => {
    const url = new URL(request.url);
    if (url.hostname === 'update.code.visualstudio.com') {
      return jsonResponse(['1.110.1']);
    }
    if (url.pathname === '/copilot_internal/v2/token') {
      return jsonResponse({ token: 'test-copilot-token', expires_at: 4102444800, refresh_in: 3600 });
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

describe('codex 1p namespace', () => {
  describe('auth', () => {
    it('accepts a floway api key supplied as `Authorization: Bearer <key>`', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
    });

    it('rejects an unknown bearer with 401', async () => {
      await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks', {
        headers: { authorization: 'Bearer not-a-floway-key' },
      });
      expect(response.status).toBe(401);
    });

    it('rejects requests with no auth header', async () => {
      await setupAppTest();
      const app = buildCodexApp();

      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks');
      expect(response.status).toBe(401);
    });
  });

  describe('chatgpt-backend stubs', () => {
    it('serves an empty JWKS so AgentIdentity deployments can opt in later', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/wham/agent-identities/jwks', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ keys: [] });
    });

    it('accepts analytics events and returns 200 so turn metadata is captured locally', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/codex/analytics-events/events', {
        method: 'POST',
        body: JSON.stringify({ events: [] }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
    });

    it.each([
      '/azure-api.codex/plugins/featured',
      '/azure-api.codex/plugins/list',
    ])('serves an empty plugin list at %s', async path => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    });

    it.each([
      '/azure-api.codex/ps/plugins/list',
      '/azure-api.codex/ps/plugins/installed',
    ])('serves an empty paginated plugin page at %s', async path => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request(path, {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ plugins: [], pagination: { next_page_token: null } });
    });
  });

  describe('responses WebSocket mount', () => {
    it('returns 426 on GET /responses without an upgrade header so the mount delegates to the generic WS handler', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/responses', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      expect(response.status).toBe(426);
      expect(await response.json()).toEqual({ error: 'Expected Upgrade: websocket' });
    });
  });

  describe('apps MCP server', () => {
    it('answers the JSON-RPC `initialize` handshake with zero-tool capabilities', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/api/codex/apps', {
        method: 'POST',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
        }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
        },
      });
    });

    it('answers `tools/list` with an empty list', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request('/azure-api.codex/api/codex/apps', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [], nextCursor: null } });
    });
  });

  describe('/models', () => {
    it('writes both context_window and max_context_window from the registry value, leaving auto_compact null so codex picks 90% itself', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      const gpt55 = body.models.find(m => m.slug === 'gpt-5.5');
      expect(gpt55).toMatchObject({
        context_window: 1050000,
        max_context_window: 1050000,
        auto_compact_token_limit: null,
      });
    });

    it('downgrades the bundled max_context_window when the registry advertises less than the bundled tier', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'gpt-5.4', maxContextWindowTokens: 272000 }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      // Bundled rust-v0.136.0 catalog has gpt-5.4 at context_window=272000
      // and max_context_window=1000000. Registry says the gateway can only
      // serve 272000, so both fields collapse to that — codex must not
      // believe a 1M ceiling we cannot honour.
      const gpt54 = body.models.find(m => m.slug === 'gpt-5.4');
      expect(gpt54?.context_window).toBe(272000);
      expect(gpt54?.max_context_window).toBe(272000);
    });

    it('drops slugs the registry does not advertise; only registry-known catalog entries reach the client', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      const slugs = body.models.map(m => m.slug);
      // The bundled catalog ships with six slugs (gpt-5.5, gpt-5.4,
      // gpt-5.4-mini, gpt-5.3-codex, gpt-5.2, codex-auto-review). Registry
      // here advertises only gpt-5.5, and codex-auto-review's target
      // (gpt-5.4) is missing — so the response is just gpt-5.5.
      expect(slugs).toEqual(['gpt-5.5']);
    });

    it('keeps codex-auto-review when its alias target is in the registry, drops it otherwise, and reports the target window', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'gpt-5.4', maxContextWindowTokens: 272000 }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      const slugs = new Set(body.models.map(m => m.slug));
      expect(slugs.has('gpt-5.4')).toBe(true);
      expect(slugs.has('codex-auto-review')).toBe(true);
      expect(slugs.has('gpt-5.5')).toBe(false);
      // codex-auto-review has no registry entry of its own, but it gets
      // rewritten to gpt-5.4 at request time, so its catalog row reports
      // gpt-5.4's window — not the bundled 1000000 max that would advertise
      // a tier the gateway cannot serve.
      const autoReview = body.models.find(m => m.slug === 'codex-auto-review');
      expect(autoReview?.context_window).toBe(272000);
      expect(autoReview?.max_context_window).toBe(272000);
    });

    it('returns an empty catalog when the registry has no overlapping slugs', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const body = await withMockedFetch(
        copilotFetch([{ id: 'claude-sonnet-4', supported_endpoints: ['/v1/messages'] }]),
        async () => {
          const response = await app.request('/azure-api.codex/models', {
            headers: { authorization: `Bearer ${apiKey.key}` },
          });
          expect(response.status).toBe(200);
          return await response.json() as CodexModelsResponse;
        },
      );
      expect(body.models).toEqual([]);
    });

    it('serves cached responses without re-running the registry on subsequent calls', async () => {
      const { apiKey } = await setupAppTest();
      const app = buildCodexApp();
      const cacheStore = new Map<string, Response>();
      const cacheStub: Cache = {
        match: async (req: Request | string) => cacheStore.get(typeof req === 'string' ? req : req.url),
        put: async (req: Request | string, response: Response) => {
          cacheStore.set(typeof req === 'string' ? req : req.url, response);
        },
      } as unknown as Cache;
      const globals = globalThis as unknown as { caches?: { default: Cache } };
      const previous = globals.caches;
      globals.caches = { default: cacheStub };
      let registryCalls = 0;
      try {
        await withMockedFetch(
          request => {
            const url = new URL(request.url);
            if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') registryCalls += 1;
            return copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }])(request);
          },
          async () => {
            const first = await app.request('/azure-api.codex/models', {
              headers: { authorization: `Bearer ${apiKey.key}` },
            });
            expect(first.status).toBe(200);
            await first.json();
            const second = await app.request('/azure-api.codex/models', {
              headers: { authorization: `Bearer ${apiKey.key}` },
            });
            expect(second.status).toBe(200);
            await second.json();
          },
        );
      } finally {
        if (previous === undefined) delete globals.caches;
        else globals.caches = previous;
      }
      expect(registryCalls).toBe(1);
      expect(cacheStore.size).toBe(1);
    });
  });
});
