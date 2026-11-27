import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAlphaSearchRoute } from '../../../src/data-plane/alpha-search/route.ts';
import { resolveConfiguredWebSearchBackend } from '../../../src/data-plane/tools/web-search/backend.ts';
import type { WebSearchConfig, WebSearchFetchPageRequest, WebSearchFetchPageResult, WebSearchBackend, WebSearchBackendRequest, WebSearchBackendResult } from '../../../src/data-plane/tools/web-search/types.ts';
import { type AuthVars, authMiddleware } from '../../../src/middleware/auth.ts';
import { internalErrorResponse } from '../../../src/middleware/internal-error-response.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';
import { withMockedFetch } from '@floway-dev/test-utils';

// Real provider construction (`createTavilyWebSearchBackend` etc.) hits the
// network; replace the resolver so tests drive a stub backend instead. A
// WebSearchConfig row is still seeded so `loadWebSearchConfig` returns a real
// value; the mock ignores it and returns the configured state each test
// wants.
vi.mock('../../../src/data-plane/tools/web-search/backend.ts');
const mockResolveConfigured = vi.mocked(resolveConfiguredWebSearchBackend);

const TAVILY_CONFIG: WebSearchConfig = {
  backend: 'tavily',
  tavily: { apiKey: 'test-key' },
  microsoftWebIq: { apiKey: '' },
  jina: { apiKey: '' },
  passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
};

const PASSTHROUGH_CONFIG: WebSearchConfig = {
  ...TAVILY_CONFIG,
  passthroughOpenAiSearch: { enabled: true, upstreamId: 'up_alpha', model: 'gpt-search' },
};

const searchUpstream = () => buildCustomUpstreamRecord({
  id: 'up_alpha',
  name: 'Alpha Search',
  config: {
    baseUrl: 'https://search.example.com',
    ingressHeadersRules: [],
    apiKey: 'search-secret',
    endpoints: { openaiResponses: {} },
    modelsFetch: { enabled: false, authStyle: 'bearer' },
  },
});

const searchManualModels = (modelIds: readonly string[]) =>
  modelIds.map(upstreamModelId => ({ upstreamModelId, kind: 'chat' as const, endpoints: { openaiResponses: {} } }));

interface ProviderOverrides {
  search?: (req: WebSearchBackendRequest) => Promise<WebSearchBackendResult> | WebSearchBackendResult;
  fetchPage?: (req: WebSearchFetchPageRequest) => Promise<WebSearchFetchPageResult> | WebSearchFetchPageResult;
}

interface BackendCall {
  kind: 'search' | 'fetchPage';
  request: WebSearchBackendRequest | WebSearchFetchPageRequest;
}

const makeStubProvider = (overrides: ProviderOverrides = {}): { backend: WebSearchBackend; calls: BackendCall[] } => {
  const calls: BackendCall[] = [];
  const backend: WebSearchBackend = {
    async search(request) {
      calls.push({ kind: 'search', request });
      if (overrides.search) return await overrides.search(request);
      return {
        type: 'ok',
        results: [{ source: 'https://example.com/a', title: 'Example A', content: [{ type: 'text', text: 'snippet A' }] }],
      };
    },
    async fetchPage(request) {
      calls.push({ kind: 'fetchPage', request });
      if (overrides.fetchPage) return await overrides.fetchPage(request);
      return {
        type: 'ok',
        pages: request.urls.map(url => ({ url, title: 'Page', content: `body of ${url}`, truncated: false, fullContentBytes: 12 })),
        failures: [],
      };
    },
  };
  return { backend, calls };
};

const buildAlphaSearchApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.onError(internalErrorResponse);
  app.use('*', authMiddleware);
  mountAlphaSearchRoute(app, PUBLIC_DATA_PLANE_ROUTES.alphaSearch);
  return app;
};

const SEARCH_PATHS = [
  '/alpha/search',
  '/v1/alpha/search',
] as const;
const SEARCH_PATH = SEARCH_PATHS[0];

const postSearch = (
  app: ReturnType<typeof buildAlphaSearchApp>,
  apiKey: string,
  body: unknown,
  path: (typeof SEARCH_PATHS)[number] = SEARCH_PATH,
) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
  });

interface SearchResponseBody {
  encrypted_output: string | null;
  output: string;
}

beforeEach(() => {
  mockResolveConfigured.mockReset();
});

describe('/alpha/search data plane', () => {
  describe('passthrough model availability', () => {
    // Each reason is a distinct production branch; the two mount paths share
    // one handler, so the rows alternate between them.
    it.each([
      { reason: 'missing-model', path: SEARCH_PATHS[0] },
      { reason: 'denied-model', path: SEARCH_PATHS[1] },
      { reason: 'excluded-upstream', path: SEARCH_PATHS[0] },
    ] as const)('returns the same missing-model response for $reason at $path', async ({ path, reason }) => {
      const { apiKey, repo } = await setupAppTest({ webSearchConfig: PASSTHROUGH_CONFIG });
      await repo.upstreams.deleteAll();
      await saveUpstreamForTest(repo.upstreams, searchUpstream(), { manualModels: searchManualModels(['gpt-search']) });
      const request = { model: 'caller-context', commands: { search_query: [{ q: 'Floway' }] } };
      let upstreamCalls = 0;
      await withMockedFetch(
        async request => {
          expect(request.url).toBe('https://search.example.com/v1/alpha/search');
          upstreamCalls++;
          return Response.json({ encrypted_output: null, output: 'allowed' });
        },
        async () => {
          await warmModelsForTest();
          const allowed = await postSearch(buildAlphaSearchApp(), apiKey.key, request, path);
          expect(allowed.status).toBe(200);
          expect(await allowed.json()).toEqual({ encrypted_output: null, output: 'allowed' });
          expect(upstreamCalls).toBe(1);
          upstreamCalls = 0;
          if (reason === 'missing-model') {
            await saveUpstreamForTest(repo.upstreams, searchUpstream(), { manualModels: searchManualModels(['another-model']) });
            await warmModelsForTest();
          } else if (reason === 'denied-model') {
            await repo.accessRecords.save({
              principal: { kind: 'user', id: apiKey.userId },
              scope: { kind: 'upstreamModel', upstreamId: 'up_alpha', model: { kind: 'exact', value: 'gpt-search' } },
              sortOrder: 0,
              values: { 'Model.Use': false },
            });
          } else {
            await repo.apiKeys.save({ ...apiKey, upstreamIds: [] });
          }
          const response = await postSearch(buildAlphaSearchApp(), apiKey.key, request, path);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: { message: 'Search model not found.', type: 'api_error' } });
          expect(upstreamCalls).toBe(0);
        },
      );
    });
  });

  describe('command execution', () => {
    it('raw-passthrough mode dispatches to the selected custom upstream and preserves its response', async () => {
      const { apiKey, repo } = await setupAppTest({ webSearchConfig: PASSTHROUGH_CONFIG });
      await repo.upstreams.deleteAll();
      await saveUpstreamForTest(repo.upstreams, searchUpstream(), { manualModels: searchManualModels(['gpt-search']) });
      const upstreamPayload = {
        encrypted_output: 'opaque',
        output: 'upstream output',
        results: [{ type: 'text_result', ref_id: 'turn0search0', url: 'https://example.com', title: 'Example', snippet: 'Snippet' }],
      };
      const immutableUpstreamResponse = await fetch(`data:application/json,${encodeURIComponent(JSON.stringify(upstreamPayload))}`);
      let upstreamBody: Record<string, unknown> | undefined;
      await withMockedFetch(
        async request => {
          if (request.url === 'https://search.example.com/v1/alpha/search') {
            upstreamBody = await request.json() as Record<string, unknown>;
            return immutableUpstreamResponse;
          }
          throw new Error(`Unhandled fetch ${request.url}`);
        },
        async () => {
          await warmModelsForTest();
          const response = await postSearch(buildAlphaSearchApp(), apiKey.key, {
            id: 'session-search',
            model: 'caller-model',
            commands: { search_query: [{ q: 'Floway' }] },
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual(upstreamPayload);
        },
      );
      expect(upstreamBody).toMatchObject({
        id: 'session-search',
        model: 'gpt-search',
        commands: { search_query: [{ q: 'Floway' }] },
      });
    });

    it('runs a search_query and returns rendered results as `output`', async () => {
      const { apiKey, repo } = await setupAppTest({ webSearchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', backend: 'tavily', impl: stub.backend });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, { commands: { search_query: [{ q: 'react hooks' }] } });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.encrypted_output).toBeNull();
      expect(body.output).toContain('Search results for "react hooks"');
      expect(body.output).toContain('[1] Example A');
      expect(body.output).toContain('https://example.com/a');
      expect(body.output).toContain('snippet A');

      // Query filters flow through from settings.search_context_size.
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].kind).toBe('search');
      expect((stub.calls[0].request as WebSearchBackendRequest).query).toBe('react hooks');

      // Usage accounted against the caller's key.
      const usage = await repo.webSearchUsage.listAll();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ backend: 'tavily', keyId: apiKey.id, action: 'search', requests: 1 });
    });

    it('maps response_length and query-level filters onto the provider request', async () => {
      const { apiKey } = await setupAppTest({ webSearchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', backend: 'tavily', impl: stub.backend });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, {
        settings: { filters: { allowed_domains: ['example.com', 'other.com'] } },
        commands: {
          search_query: [{ q: 'react', domains: ['example.com', 'blocked.com'], recency: 7 }],
          response_length: 'short',
        },
      });
      expect(response.status).toBe(200);
      expect(stub.calls).toHaveLength(1);
      const request = stub.calls[0].request as WebSearchBackendRequest;
      expect(request.maxResults).toBe(10);
      expect(request.allowedDomains).toEqual(['example.com']);
      expect(request.recencyDays).toBe(7);
    });

    it('does not widen filtering when global and query domains do not intersect', async () => {
      const { apiKey } = await setupAppTest({ webSearchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', backend: 'tavily', impl: stub.backend });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, {
        settings: { filters: { allowed_domains: ['example.com'] } },
        commands: { search_query: [{ q: 'react', domains: ['other.com'] }] },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('(no results)');
      expect(stub.calls).toHaveLength(0);
    });
  });
});
