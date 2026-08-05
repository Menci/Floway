import { expect, test, vi } from 'vitest';

import { assertOllamaUpstreamRecord, type OllamaUpstreamConfig } from '../src/config.ts';
import { fetchOllamaCatalog } from '../src/fetch-models.ts';
import { ProviderModelsUnavailableError, directFetcher, type Fetcher } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const config: OllamaUpstreamConfig = assertOllamaUpstreamRecord({
  id: 'up_ollama',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
}).config;

const tagsBody = {
  models: [
    { name: 'gpt-oss:120b', modified_at: '2025-08-05T00:00:00Z' },
    { name: 'nomic-embed-text:latest', modified_at: '2025-04-01T00:00:00Z' },
    { name: 'empty', modified_at: '' },
  ],
};

const showBodies: Record<string, unknown> = {
  'gpt-oss:120b': {
    capabilities: ['completion', 'tools', 'thinking'],
    details: { family: 'gptoss', parameter_size: '116829156672', quantization_level: 'MXFP4' },
    model_info: {
      'general.architecture': 'gptoss',
      'general.parameter_count': 116829156672,
      'gptoss.context_length': 131072,
      'gptoss.embedding_length': 2880,
    },
  },
  'nomic-embed-text:latest': {
    capabilities: ['embedding'],
    details: { family: 'nomic-bert', quantization_level: 'F16' },
    model_info: {
      'general.architecture': 'nomic-bert',
      'general.parameter_count': 137000000,
      'nomic-bert.context_length': 8192,
      'nomic-bert.embedding_length': 768,
    },
  },
  // `empty` returns an error from /api/show to prove a single show failure
  // does not poison the catalog.
};

const respond = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === '/api/tags') return jsonResponse(tagsBody);
  if (url.pathname === '/api/show') {
    const body = await request.json() as { name?: string };
    const name = body.name ?? '';
    if (!(name in showBodies)) return new Response('not found', { status: 404 });
    return jsonResponse(showBodies[name]);
  }
  return new Response('unexpected', { status: 500 });
};

test('fetchOllamaCatalog projects /api/show capabilities + model_info into the raw model shape', async () => {
  await withMockedFetch(respond, async () => {
    const catalog = await fetchOllamaCatalog(config, directFetcher);
    const ids = catalog.data.map(m => m.id);
    // The `empty` tag's /api/show 404 drops it from the catalog without
    // affecting the others; the embedding model is included so kind/endpoints
    // projection can react to its capability set.
    assertEquals(ids.sort(), ['gpt-oss:120b', 'nomic-embed-text:latest']);

    const gptoss = catalog.data.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.capabilities.has('thinking'), true);
    assertEquals(gptoss.capabilities.has('tools'), true);
    assertEquals(gptoss.capabilities.has('embedding'), false);
    assertEquals(gptoss.contextLength, 131072);
    assertEquals(gptoss.modifiedAt, Math.floor(Date.parse('2025-08-05T00:00:00Z') / 1000));

    const embed = catalog.data.find(m => m.id === 'nomic-embed-text:latest')!;
    assertEquals(embed.capabilities.has('embedding'), true);
    // model_info keys are arch-prefixed; the fetcher must enumerate keys to
    // find `.context_length` without hardcoding `gptoss.`.
    assertEquals(embed.contextLength, 8192);
  });
});

test('fetchOllamaCatalog rejects with ProviderModelsUnavailableError when /api/tags returns a shape it cannot parse', async () => {
  // 200 OK + body that satisfies isRecord but lacks a `models` array. The
  // scaffold must see parseTagsResponse return null and convert that to the
  // shared error class (rather than the catalog quietly resolving to []).
  await withMockedFetch(
    async () => jsonResponse({ unexpected: 'shape' }),
    async () => {
      await assertRejects(
        () => fetchOllamaCatalog(config, directFetcher),
        ProviderModelsUnavailableError,
      );
    },
  );

  await withMockedFetch(
    async () => jsonResponse({ models: [{}, { name: '' }] }),
    async () => {
      await assertRejects(
        () => fetchOllamaCatalog(config, directFetcher),
        ProviderModelsUnavailableError,
      );
    },
  );
});

test('fetchOllamaCatalog bounds /api/show concurrency and deduplicates repeated tags', async () => {
  const names = Array.from({ length: 20 }, (_, index) => `model-${index}`);
  let active = 0;
  let peak = 0;
  const showCalls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let reachedPoolLimit!: () => void;
  const poolLimitReached = new Promise<void>(resolve => { reachedPoolLimit = resolve; });

  const fetcher: Fetcher = async (url, init) => {
    if (new URL(url).pathname === '/api/tags') {
      return jsonResponse({ models: [...names.map(name => ({ name })), { name: names[0] }] });
    }
    const name = (JSON.parse(String(init.body)) as { name: string }).name;
    showCalls.push(name);
    active++;
    peak = Math.max(peak, active);
    if (active === 8) reachedPoolLimit();
    await gate;
    active--;
    return jsonResponse({ capabilities: [], model_info: {} });
  };

  const pending = fetchOllamaCatalog(config, fetcher);
  await poolLimitReached;
  const startedBeforeRelease = showCalls.length;
  release();
  const catalog = await pending;

  expect(startedBeforeRelease).toBe(8);
  expect(peak).toBe(8);
  expect(showCalls).toHaveLength(names.length);
  expect(new Set(showCalls).size).toBe(names.length);
  expect(catalog.data.map(model => model.id)).toEqual(names);
});

test('fetchOllamaCatalog cancels discarded and oversized /api/show bodies without poisoning siblings', async () => {
  let failedCancelled = false;
  let oversizedCancelled = false;
  const responseBody = (bytes: Uint8Array, onCancel: () => void) => new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      onCancel();
      return new Promise<void>(() => {});
    },
  });
  const fetcher: Fetcher = (_url, init) => {
    if (init.method === 'GET') {
      return Promise.resolve(jsonResponse({ models: [{ name: 'failed' }, { name: 'oversized' }, { name: 'valid' }] }));
    }
    const name = (JSON.parse(String(init.body)) as { name: string }).name;
    if (name === 'failed') {
      return Promise.resolve(new Response(responseBody(new TextEncoder().encode('failure'), () => { failedCancelled = true; }), { status: 500 }));
    }
    if (name === 'oversized') {
      return Promise.resolve(new Response(responseBody(new TextEncoder().encode('{"capabilities":[]}'), () => { oversizedCancelled = true; })));
    }
    return Promise.resolve(jsonResponse({}));
  };

  const catalog = await fetchOllamaCatalog(config, fetcher, { maxShowResponseBytes: 8 });
  expect(catalog.data.map(model => model.id)).toEqual(['valid']);
  expect(failedCancelled).toBe(true);
  expect(oversizedCancelled).toBe(true);
});

test('fetchOllamaCatalog propagates cancellation from /api/show fetch and body decoding', async () => {
  const cancelledShows: Array<(abort: DOMException) => Promise<Response>> = [
    abort => Promise.reject(abort),
    abort => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.error(abort);
      },
    }))),
  ];
  for (const cancelledShow of cancelledShows) {
    const abort = new DOMException('cancelled', 'AbortError');
    const fetcher: Fetcher = (url, init) => {
      if (new URL(url).pathname === '/api/tags') {
        return Promise.resolve(jsonResponse({ models: [{ name: 'first' }, { name: 'second' }] }));
      }
      const name = (JSON.parse(String(init.body)) as { name: string }).name;
      if (name === 'first') return cancelledShow(abort);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    await expect(fetchOllamaCatalog(config, fetcher)).rejects.toBe(abort);
  }
});

test('fetchOllamaCatalog aborts stalled show requests and rejects systemic detail failure', async () => {
  vi.useFakeTimers();
  try {
    let upstreamReason: unknown;
    const fetcher: Fetcher = (url, init) => {
      if (new URL(url).pathname === '/api/tags') {
        return Promise.resolve(jsonResponse({ models: [{ name: 'stalled' }] }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          upstreamReason = init.signal?.reason;
          reject(init.signal?.reason);
        }, { once: true });
      });
    };
    const stalled = fetchOllamaCatalog(config, fetcher, { totalTimeoutMs: 35 });
    const assertion = expect(stalled).rejects.toMatchObject({
      name: 'ProviderModelsUnavailableError',
      cause: expect.objectContaining({ name: 'TimeoutError' }),
    });
    await vi.advanceTimersByTimeAsync(35);
    await assertion;
    expect(upstreamReason).toMatchObject({ name: 'TimeoutError' });
  } finally {
    vi.useRealTimers();
  }
});
