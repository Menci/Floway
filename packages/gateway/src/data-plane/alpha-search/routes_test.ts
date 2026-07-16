import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAlphaSearchRoutes } from './routes.ts';
import { type AuthVars, authMiddleware } from '../../middleware/auth.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../test-helpers.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import type { SearchConfig, WebSearchFetchPageRequest, WebSearchFetchPageResult, WebSearchProvider, WebSearchProviderRequest, WebSearchProviderResult } from '../tools/web-search/types.ts';
import { withMockedFetch } from '@floway-dev/test-utils';

// Real provider construction (`createTavilyWebSearchProvider` etc.) hits the
// network; replace the resolver so tests drive a stub backend instead. A
// SearchConfig row is still seeded so `loadSearchConfig` returns a real
// value; the mock ignores it and returns the configured state each test
// wants.
vi.mock('../tools/web-search/provider.ts');
const mockResolveConfigured = vi.mocked(resolveConfiguredWebSearchProvider);

const TAVILY_CONFIG: SearchConfig = {
  provider: 'tavily',
  tavily: { apiKey: 'test-key' },
  microsoftGrounding: { apiKey: '' },
  jina: { apiKey: '' },
  passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
};

interface ProviderOverrides {
  search?: (req: WebSearchProviderRequest) => Promise<WebSearchProviderResult> | WebSearchProviderResult;
  fetchPage?: (req: WebSearchFetchPageRequest) => Promise<WebSearchFetchPageResult> | WebSearchFetchPageResult;
}

interface BackendCall {
  kind: 'search' | 'fetchPage';
  request: WebSearchProviderRequest | WebSearchFetchPageRequest;
}

const makeStubProvider = (overrides: ProviderOverrides = {}): { provider: WebSearchProvider; calls: BackendCall[] } => {
  const calls: BackendCall[] = [];
  const provider: WebSearchProvider = {
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
  return { provider, calls };
};

const buildAlphaSearchApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', authMiddleware);
  mountAlphaSearchRoutes(app);
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
  describe('routing and auth', () => {
    it.each(SEARCH_PATHS)('serves the same handler at %s', async path => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, { commands: { search_query: [{ q: 'route probe' }] } }, path);
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('Search results for "route probe"');
    });

    it.each(SEARCH_PATHS)('rejects missing auth at %s', async path => {
      await setupAppTest();
      const app = buildAlphaSearchApp();
      const response = await app.request(path, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      expect(response.status).toBe(401);
    });

    it.each(SEARCH_PATHS)('rejects an unknown bearer at %s', async path => {
      await setupAppTest();
      const app = buildAlphaSearchApp();
      const response = await postSearch(app, 'not-an-api-key', {}, path);
      expect(response.status).toBe(401);
    });
  });

  describe('schema validation', () => {
    it.each(SEARCH_PATHS)('rejects non-object `commands` at %s', async path => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const app = buildAlphaSearchApp();
      const response = await postSearch(app, apiKey.key, { commands: [] }, path);
      expect(response.status).toBe(400);
    });

    it.each(SEARCH_PATHS)('rejects unknown search_context_size at %s', async path => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const app = buildAlphaSearchApp();
      const response = await postSearch(app, apiKey.key, { settings: { search_context_size: 'huge' } }, path);
      expect(response.status).toBe(400);
    });

    it('accepts and ignores the model/id/reasoning/input/max_output_tokens fields codex always sends', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildAlphaSearchApp();
      const response = await postSearch(app, apiKey.key, {
        id: 'session-1',
        model: 'gpt-5.5',
        reasoning: { effort: 'high' },
        input: 'find me the docs',
        max_output_tokens: 2048,
        commands: { search_query: [{ q: 'react hooks' }] },
      });
      expect(response.status).toBe(200);
    });
  });

  describe('command execution', () => {
    it('raw-passthrough mode dispatches to the selected custom upstream and preserves its response', async () => {
      const searchConfig: SearchConfig = {
        ...TAVILY_CONFIG,
        passthroughOpenAiSearch: { enabled: true, upstreamId: 'up_alpha', model: 'gpt-search' },
      };
      const { apiKey, repo } = await setupAppTest({ searchConfig });
      await repo.upstreams.deleteAll();
      await repo.upstreams.save(buildCustomUpstreamRecord({
        id: 'up_alpha',
        name: 'Alpha Search',
        config: {
          baseUrl: 'https://search.example.com',
          authStyle: 'bearer',
          apiKey: 'search-secret',
          endpoints: { responses: {} },
          modelsFetch: { enabled: false },
          models: [{ upstreamModelId: 'gpt-search', endpoints: { responses: {} } }],
        },
      }));
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
      const { apiKey, repo } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
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
      expect((stub.calls[0].request as WebSearchProviderRequest).query).toBe('react hooks');

      // Usage accounted against the caller's key.
      const usage = await repo.searchUsage.listAll();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ provider: 'tavily', keyId: apiKey.id, action: 'search', requests: 1 });
    });

    it('opens a page and returns its body text; accounts one fetch_page usage row', async () => {
      const { apiKey, repo } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, { commands: { open: [{ ref_id: 'https://example.com/doc' }] } });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('body of https://example.com/doc');

      const usage = await repo.searchUsage.listAll();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ provider: 'tavily', keyId: apiKey.id, action: 'fetch_page', requests: 1 });
    });

    it('finds a pattern inside an opened page and renders the matches', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider({
        fetchPage: req => ({
          type: 'ok',
          pages: req.urls.map(url => ({ url, title: 'Page', content: 'alpha beta gamma beta delta', truncated: false, fullContentBytes: 27 })),
          failures: [],
        }),
      });
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, { commands: { find: [{ ref_id: 'https://example.com/doc', pattern: 'beta' }] } });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('2 matches for pattern: `beta`');
    });

    it('concatenates multiple commands in order with a blank-line separator', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, {
        commands: {
          search_query: [{ q: 'first' }, { q: 'second' }],
          open: [{ ref_id: 'https://example.com/p' }],
        },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      const blocks = body.output.split('\n\n');
      expect(body.output).toContain('Search results for "first"');
      expect(body.output).toContain('Search results for "second"');
      expect(body.output).toContain('body of https://example.com/p');
      // Search rendering itself contains blank lines, so assert on markers
      // rather than exact block count.
      expect(blocks.length).toBeGreaterThan(1);
    });

    it('renders unimplemented command kinds as deterministic text without hitting the provider', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, {
        commands: { screenshot: [{ ref_id: 'https://example.com', pageno: 0 }], response_length: 'short' },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('the `screenshot` sub-property is not supported');
      expect(body.output).toContain('the `response_length` sub-property is not supported');
      expect(stub.calls).toHaveLength(0);
    });

    it('returns a helpful message when no commands are provided', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const app = buildAlphaSearchApp();
      const response = await postSearch(app, apiKey.key, { commands: {} });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('No web search commands were provided');
    });

    it('blocks an open URL outside the allowed_domains filter', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, {
        settings: { filters: { allowed_domains: ['example.org'] } },
        commands: { open: [{ ref_id: 'https://example.com/blocked' }] },
      });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('Blocked by tool filters');
      // Blocked URLs never reach the provider.
      expect(stub.calls).toHaveLength(0);
    });
  });

  describe('provider not configured', () => {
    it('surfaces disabled search as in-band output text (contract-shaped 200)', async () => {
      const { apiKey, repo } = await setupAppTest();
      mockResolveConfigured.mockReturnValue({ type: 'disabled' });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, { commands: { search_query: [{ q: 'anything' }] } });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.encrypted_output).toBeNull();
      expect(body.output).toContain('Web search provider is not configured on this gateway.');
      // Nothing was billed because no backend ran.
      expect(await repo.searchUsage.listAll()).toHaveLength(0);
    });

    it('surfaces a missing provider credential as in-band output text', async () => {
      const { apiKey } = await setupAppTest();
      mockResolveConfigured.mockReturnValue({ type: 'missing-credential', provider: 'tavily' });
      const app = buildAlphaSearchApp();

      const response = await postSearch(app, apiKey.key, { commands: { search_query: [{ q: 'anything' }] } });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('Web search provider tavily is missing its credential on this gateway.');
    });
  });
});
