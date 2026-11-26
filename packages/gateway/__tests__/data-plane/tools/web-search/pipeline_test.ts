import { expect, test, vi } from 'vitest';

import { DEFAULT_WEB_SEARCH_CONFIG } from '../../../../src/data-plane/tools/web-search/config.ts';
import { parseWebSearchOperations } from '../../../../src/data-plane/tools/web-search/operations.ts';
import { createLocalWebSearchService, localWebSearch, type LocalWebSearchService } from '../../../../src/data-plane/tools/web-search/pipeline.ts';
import { createJinaWebSearchProvider } from '../../../../src/data-plane/tools/web-search/providers/jina.ts';
import { createMicrosoftWebIqWebSearchProvider } from '../../../../src/data-plane/tools/web-search/providers/microsoft-web-iq.ts';
import { createTavilyWebSearchProvider } from '../../../../src/data-plane/tools/web-search/providers/tavily.ts';
import type { WebSearchProvider } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { UpstreamTransportError } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';

test('search routing exposes a credential-free projection and shares the lazy configuration read', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const passthroughOpenAiSearch = { enabled: true, upstreamId: 'fixture-upstream', model: 'fixture-model' };
  await repo.webSearchConfig.save({
    ...DEFAULT_WEB_SEARCH_CONFIG,
    passthroughOpenAiSearch,
    provider: 'tavily',
    tavily: { apiKey: 'fixture-secret' },
  });
  const read = vi.spyOn(repo.webSearchConfig, 'get');
  const service = createLocalWebSearchService();
  expect(read).not.toHaveBeenCalled();

  const [routing, provider, repeatedProvider] = await Promise.all([
    service.passthroughConfiguration(),
    service.getProvider(),
    service.getProvider(),
  ]);
  expect(routing).toEqual(passthroughOpenAiSearch);
  expect(provider).toMatchObject({ type: 'enabled', provider: 'tavily' });
  expect(repeatedProvider).toBe(provider);
  expect(read).toHaveBeenCalledTimes(1);
});

test.each([
  ['Jina', createJinaWebSearchProvider],
  ['Microsoft Web IQ', createMicrosoftWebIqWebSearchProvider],
  ['Tavily', createTavilyWebSearchProvider],
] as const)('%s preserves confirmed cancellation at its fetch boundaries', async (_name, create) => {
  for (const operation of ['search', 'fetchPage'] as const) {
    const controller = new AbortController();
    const reason = new Error('search operation cancelled');
    const failure = new Error('fetch cancelled', { cause: reason });
    const provider = create('fixture', {
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        controller.abort(reason);
        throw failure;
      },
    });
    const outcome = operation === 'search'
      ? provider.search({ query: 'fixture', signal: controller.signal })
      : provider.fetchPage({ urls: ['https://test.example/page'], signal: controller.signal });
    await expect(outcome).rejects.toBe(failure);
  }
});

test.each([
  ['Jina', createJinaWebSearchProvider],
  ['Microsoft Web IQ', createMicrosoftWebIqWebSearchProvider],
  ['Tavily', createTavilyWebSearchProvider],
] as const)('%s preserves transport failures and propagates unrelated defects', async (_name, create) => {
  const failure = new UpstreamTransportError(new Error('classified socket failure'));
  const transport = create('fixture', { fetch: async () => { throw failure; } });
  await expect(transport.search({ query: 'fixture' })).resolves.toEqual({
    type: 'error', errorCode: 'unavailable', message: failure.message,
  });
  await expect(transport.fetchPage({ urls: ['https://test.example/page'] })).resolves.toEqual({
    type: 'error', errorCode: 'unavailable', message: failure.message,
  });

  const controller = new AbortController();
  const defect = new SyntaxError('programmer error after abort');
  const failedBody = create('fixture', {
    fetch: async () => {
      const response = new Response('{}');
      response.text = async () => {
        controller.abort(new Error('unrelated client cancellation'));
        throw defect;
      };
      return response;
    },
  });
  await expect(failedBody.search({ query: 'fixture', signal: controller.signal })).rejects.toBe(defect);
});

test.each([
  ['provider', 'cancelled'],
  ['operations', 'cancelled'],
  ['provider', 'panic'],
  ['operations', 'panic'],
] as const)('settles the %s request arm according to the causal I/O outcome %s', async (kind, mode) => {
  initRepo(new InMemoryRepo());
  const reason = new Error('search request cancelled');
  const unrelated = new DOMException('unrelated backend failure', 'AbortError');
  const started = Promise.withResolvers<void>();
  const search: WebSearchProvider['search'] = async ({ signal }) => {
    if (signal === undefined) throw new TypeError('Expected the search operation signal');
    started.resolve();
    return await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(mode === 'cancelled'
        ? new Error('backend aborted', { cause: signal.reason })
        : unrelated), { once: true });
    });
  };
  const localWebSearchService: LocalWebSearchService = {
    ...createLocalWebSearchService(),
    getProvider: async () => ({
      type: 'enabled', provider: 'tavily', impl: {
        search,
        async fetchPage() { throw new Error('Unexpected page fetch'); },
      },
    }),
  };
  const controller = new AbortController();
  const running = run(localWebSearch, {
    'request.auth.apiKeyId': 'test-key',
    'request.webSearch': kind === 'provider' ? { kind, query: { query: 'fixture' } } : {
      kind,
      operations: { kind: 'single', operation: { kind: 'search', query: 'fixture', arrayIndex: 0 } },
      filters: { maxResults: 4 },
      includeSearchActionSources: false,
    },
  }, { services: { localWebSearch: localWebSearchService }, signal: controller.signal, waitUntil: () => {} });
  await started.promise;
  controller.abort(reason);
  if (mode === 'cancelled') {
    const result = await running.result;
    expect(result['response.webSearch']).toEqual({ kind: 'abort', cause: reason });
    await expect(running.done).resolves.toBeUndefined();
  } else {
    await expect(running.result).rejects.toBe(unrelated);
    await expect(running.done).rejects.toBe(unrelated);
  }
});

test('local search preserves provider result fields and binds the child signal', async () => {
  initRepo(new InMemoryRepo());
  const result = {
    type: 'ok' as const,
    results: [{ source: 'https://test.example/result', title: 'Result', pageAge: '2026-01-02', content: [{ type: 'text' as const, text: 'source' }] }],
  };
  const search = vi.fn<WebSearchProvider['search']>().mockResolvedValue(result);
  const localWebSearchService: LocalWebSearchService = {
    passthroughConfiguration: async () => DEFAULT_WEB_SEARCH_CONFIG.passthroughOpenAiSearch,
    getProvider: async () => ({
      type: 'enabled', provider: 'tavily', impl: {
        search,
        async fetchPage() { throw new Error('Unexpected page fetch'); },
      },
    }),
    pageCache: createLocalWebSearchService().pageCache,
  };
  const controller = new AbortController();
  const running = run(localWebSearch, {
    'request.auth.apiKeyId': 'test-key',
    'request.webSearch': { kind: 'provider', query: { query: 'fixture', allowedDomains: ['test.example'] } },
  }, { services: { localWebSearch: localWebSearchService }, signal: controller.signal, waitUntil: () => {} });
  expect(await running.result).toEqual({ 'response.webSearch': { kind: 'provider', result } });
  controller.abort();
  await running.done;
  expect(search).toHaveBeenCalledWith({ query: 'fixture', allowedDomains: ['test.example'], signal: expect.any(AbortSignal) });
});

test('page batches fetch once and use the same per-request cache for later operations', async () => {
  initRepo(new InMemoryRepo());
  const url = 'https://test.example/page';
  const fetchPage = vi.fn<WebSearchProvider['fetchPage']>().mockResolvedValue({
    type: 'ok',
    pages: [{ url, title: 'Reusable page', content: 'fixture contains a target', truncated: false, fullContentBytes: 25 }],
    failures: [],
  });
  const instance = createLocalWebSearchService();
  const localWebSearchService: LocalWebSearchService = {
    ...instance,
    getProvider: async () => ({
      type: 'enabled', provider: 'tavily', impl: {
        async search() { throw new Error('Unexpected search'); },
        fetchPage,
      },
    }),
  };
  const issue = async (command: Record<string, unknown>) => {
    const parsed = parseWebSearchOperations(command);
    if (parsed.kind !== 'ops') throw new Error('Expected valid operations');
    const controller = new AbortController();
    const request = run(localWebSearch, {
      'request.auth.apiKeyId': 'test-key',
      'request.webSearch': {
        kind: 'operations', operations: { kind: 'batch', operations: parsed.ops },
        filters: { maxResults: 4 }, includeSearchActionSources: false,
      },
    }, { services: { localWebSearch: localWebSearchService }, signal: controller.signal, waitUntil: () => {} });
    const { 'response.webSearch': response } = await request.result;
    controller.abort();
    await request.done;
    if (response.kind !== 'batch') throw new Error('Expected a batched response');
    return response.result;
  };
  expect(await issue({ open: [{ ref_id: url }] })).toEqual([expect.objectContaining({ action: { type: 'open_page', url } })]);
  expect(await issue({ find: [{ ref_id: url, pattern: 'target' }] })).toEqual([
    expect.objectContaining({ action: { type: 'find_in_page', url, pattern: 'target' } }),
  ]);
  expect(fetchPage).toHaveBeenCalledTimes(1);
});
