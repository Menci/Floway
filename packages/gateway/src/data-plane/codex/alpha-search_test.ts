import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountCodexRoutes } from './routes.ts';
import { type AuthVars, authMiddleware } from '../../middleware/auth.ts';
import { setupAppTest } from '../../test-helpers.ts';
import { resolveConfiguredWebSearchProvider } from '../tools/web-search/provider.ts';
import type { SearchConfig, WebSearchFetchPageRequest, WebSearchFetchPageResult, WebSearchProvider, WebSearchProviderRequest, WebSearchProviderResult } from '../tools/web-search/types.ts';

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

const buildCodexApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', authMiddleware);
  mountCodexRoutes(app);
  return app;
};

const SEARCH_PATH = '/azure-api.codex/alpha/search';

const postSearch = (app: ReturnType<typeof buildCodexApp>, apiKey: string, body: unknown) =>
  app.request(SEARCH_PATH, {
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

describe('codex /alpha/search', () => {
  describe('auth', () => {
    it('rejects requests with no auth header (401)', async () => {
      await setupAppTest();
      const app = buildCodexApp();
      const response = await app.request(SEARCH_PATH, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      expect(response.status).toBe(401);
    });

    it('rejects an unknown bearer (401)', async () => {
      await setupAppTest();
      const app = buildCodexApp();
      const response = await postSearch(app, 'not-an-api-key', {});
      expect(response.status).toBe(401);
    });
  });

  describe('schema validation', () => {
    it('rejects a non-object `commands` with 400', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const app = buildCodexApp();
      const response = await postSearch(app, apiKey.key, { commands: [] });
      expect(response.status).toBe(400);
    });

    it('rejects an unknown search_context_size with 400', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const app = buildCodexApp();
      const response = await postSearch(app, apiKey.key, { settings: { search_context_size: 'huge' } });
      expect(response.status).toBe(400);
    });

    it('accepts and ignores the model/id/reasoning/input/max_output_tokens fields codex always sends', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildCodexApp();
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
    it('runs a search_query and returns rendered results as `output`', async () => {
      const { apiKey, repo } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildCodexApp();

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
      const app = buildCodexApp();

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
      const app = buildCodexApp();

      const response = await postSearch(app, apiKey.key, { commands: { find: [{ ref_id: 'https://example.com/doc', pattern: 'beta' }] } });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('2 matches for pattern: `beta`');
    });

    it('concatenates multiple commands in order with a blank-line separator', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildCodexApp();

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
      const app = buildCodexApp();

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
      const app = buildCodexApp();
      const response = await postSearch(app, apiKey.key, { commands: {} });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('No web search commands were provided');
    });

    it('blocks an open URL outside the allowed_domains filter', async () => {
      const { apiKey } = await setupAppTest({ searchConfig: TAVILY_CONFIG });
      const stub = makeStubProvider();
      mockResolveConfigured.mockReturnValue({ type: 'enabled', provider: 'tavily', impl: stub.provider });
      const app = buildCodexApp();

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
      const app = buildCodexApp();

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
      const app = buildCodexApp();

      const response = await postSearch(app, apiKey.key, { commands: { search_query: [{ q: 'anything' }] } });
      expect(response.status).toBe(200);
      const body = await response.json() as SearchResponseBody;
      expect(body.output).toContain('Web search provider tavily is missing its credential on this gateway.');
    });
  });
});
