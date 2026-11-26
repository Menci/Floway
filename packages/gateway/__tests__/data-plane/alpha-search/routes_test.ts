import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountAlphaSearchRoutes } from '../../../src/data-plane/alpha-search/routes.ts';
import type { WebSearchConfig } from '../../../src/data-plane/tools/web-search/types.ts';
import { type AuthVars, authMiddleware } from '../../../src/middleware/auth.ts';
import { internalErrorResponse } from '../../../src/middleware/internal-error-response.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
import { withMockedFetch } from '@floway-dev/test-utils';

const TAVILY_CONFIG: WebSearchConfig = {
  provider: 'tavily',
  tavily: { apiKey: 'test-key' },
  microsoftWebIq: { apiKey: '' },
  jina: { apiKey: '' },
  passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
};

const PASSTHROUGH_CONFIG: WebSearchConfig = {
  ...TAVILY_CONFIG,
  passthroughOpenAiSearch: { enabled: true, upstreamId: 'up_alpha', model: 'gpt-search' },
};

const searchUpstream = (modelIds: readonly string[]) => buildCustomUpstreamRecord({
  id: 'up_alpha',
  name: 'Alpha Search',
  config: {
    baseUrl: 'https://search.example.com',
    ingressHeadersRules: [],
    apiKey: 'search-secret',
    endpoints: { openaiResponses: {} },
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models: modelIds.map(upstreamModelId => ({ upstreamModelId, endpoints: { openaiResponses: {} } })),
  },
});

const withTavily = async (requests: unknown[], run: () => Promise<void>): Promise<void> =>
  await withMockedFetch(
    async request => {
      expect(request.url).toBe('https://api.tavily.com/search');
      requests.push(await request.json());
      return Response.json({ results: [{ url: 'https://example.com/a', title: 'Example A', content: 'snippet A' }] });
    },
    run,
  );

const buildAlphaSearchApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.onError(internalErrorResponse);
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
      await saveUpstreamForTest(repo.upstreams, searchUpstream(['gpt-search']));
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
            await saveUpstreamForTest(repo.upstreams, searchUpstream(['another-model']));
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
    it('dispatches to the selected custom upstream and preserves its response bytes', async () => {
      const { apiKey, repo } = await setupAppTest({ webSearchConfig: PASSTHROUGH_CONFIG });
      await repo.upstreams.deleteAll();
      await saveUpstreamForTest(repo.upstreams, searchUpstream(['gpt-search']));
      const upstreamPayload = {
        encrypted_output: 'opaque',
        output: 'upstream output',
        results: [{ type: 'text_result', ref_id: 'turn0search0', url: 'https://example.com', title: 'Example', snippet: 'Snippet' }],
      };
      const upstreamBytes = `${JSON.stringify(upstreamPayload, null, 2)}\n`;
      const immutableUpstreamResponse = await fetch(`data:application/json,${encodeURIComponent(upstreamBytes)}`);
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
          expect(await response.text()).toBe(upstreamBytes);
        },
      );
      expect(upstreamBody).toMatchObject({
        id: 'session-search',
        model: 'gpt-search',
        commands: { search_query: [{ q: 'Floway' }] },
      });
    });

    it.each([
      { status: 200, body: 'non-JSON result' },
      { status: 200, body: '[]' },
      { status: 204, body: null },
    ])('relays upstream status $status and successful bytes $body verbatim', async ({ status, body }) => {
      const { apiKey, repo } = await setupAppTest({ webSearchConfig: PASSTHROUGH_CONFIG });
      await repo.upstreams.deleteAll();
      await saveUpstreamForTest(repo.upstreams, searchUpstream(['gpt-search']));
      await withMockedFetch(
        () => new Response(body, { status, headers: { 'content-type': 'application/json', 'x-provider-trace': 'search' } }),
        async () => {
          await warmModelsForTest();
          const response = await postSearch(buildAlphaSearchApp(), apiKey.key, { commands: {} });
          expect(response.status).toBe(status);
          expect(response.headers.get('x-provider-trace')).toBe('search');
          if (body === null) expect(response.body).toBeNull();
          else expect(await response.text()).toBe(body);
        },
      );
      await flushAsyncWork();
      expect(await repo.usage.listAll()).toEqual([]);
      expect(await repo.performance.listAll()).toMatchObject([{ operation: 'alpha_search', requests: 1, errorsNoOutput: 0 }]);
    });

    it('runs a search_query and returns rendered results as `output`', async () => {
      const { apiKey, repo } = await setupAppTest({ webSearchConfig: TAVILY_CONFIG });
      const requests: unknown[] = [];
      await withTavily(requests, async () => {
        const response = await postSearch(buildAlphaSearchApp(), apiKey.key, { commands: { search_query: [{ q: 'react hooks' }] } });
        expect(response.status).toBe(200);
        const body = await response.json() as SearchResponseBody;
        expect(body.encrypted_output).toBeNull();
        expect(body.output).toContain('Search results for "react hooks"');
        expect(body.output).toContain('[1] Example A');
        expect(body.output).toContain('https://example.com/a');
        expect(body.output).toContain('snippet A');
      });
      expect(requests).toMatchObject([{ query: 'react hooks' }]);
      const usage = await repo.webSearchUsage.listAll();
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ provider: 'tavily', keyId: apiKey.id, action: 'search', requests: 1 });
    });

    it('maps response_length and query-level filters onto the provider request', async () => {
      const { apiKey } = await setupAppTest({ webSearchConfig: TAVILY_CONFIG });
      const requests: unknown[] = [];
      await withTavily(requests, async () => {
        const response = await postSearch(buildAlphaSearchApp(), apiKey.key, {
          settings: { filters: { allowed_domains: ['example.com', 'other.com'] } },
          commands: {
            search_query: [{ q: 'react', domains: ['example.com', 'blocked.com'], recency: 7 }],
            response_length: 'short',
          },
        });
        expect(response.status).toBe(200);
        await response.text();
      });
      expect(requests).toMatchObject([{ query: 'react', max_results: 10, include_domains: ['example.com'], time_range: 'week' }]);
    });

    it('does not widen filtering when global and query domains do not intersect', async () => {
      const { apiKey } = await setupAppTest({ webSearchConfig: TAVILY_CONFIG });
      const requests: unknown[] = [];
      await withTavily(requests, async () => {
        const response = await postSearch(buildAlphaSearchApp(), apiKey.key, {
          settings: { filters: { allowed_domains: ['example.com'] } },
          commands: { search_query: [{ q: 'react', domains: ['other.com'] }] },
        });
        expect(response.status).toBe(200);
        const body = await response.json() as SearchResponseBody;
        expect(body.output).toContain('(no results)');
      });
      expect(requests).toHaveLength(0);
    });

    it('batches open and find URLs in one provider call and renders each command in order', async () => {
      const { apiKey } = await setupAppTest({ webSearchConfig: TAVILY_CONFIG });
      const open = 'https://example.com/open';
      const find = 'https://example.com/find';
      const requests: unknown[] = [];
      await withMockedFetch(
        async request => {
          expect(request.url).toBe('https://api.tavily.com/extract');
          requests.push(await request.json());
          return Response.json({
            results: [
              { url: open, raw_content: 'opened page content' },
              { url: find, raw_content: 'found search target on this page' },
            ],
          });
        },
        async () => {
          const response = await postSearch(buildAlphaSearchApp(), apiKey.key, {
            commands: {
              open: [{ ref_id: open }],
              find: [{ ref_id: find, pattern: 'search target' }],
            },
          });
          expect(response.status).toBe(200);
          const { output } = await response.json() as SearchResponseBody;
          expect(output).toContain('found [search target] on this page');
          expect(output.startsWith('opened page content')).toBe(true);
        },
      );
      expect(requests).toMatchObject([{ urls: [open, find] }]);
    });
  });
});
