import { expect, test, vi } from 'vitest';

import { executeAlphaSearch } from '../../../../../src/data-plane/tools/web-search/alpha-search/execution.ts';
import type { AlphaSearchDispatcher } from '../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('executeAlphaSearch preserves model-facing output without retyping opaque alpha results', async () => {
  const call = vi.fn<AlphaSearchDispatcher>(async () => new Response(JSON.stringify({
    encrypted_output: 'opaque',
    output: 'rendered output',
    results: [{ type: 'text_result', ref_id: 'turn0search0', url: 'https://example.com', title: 'Example', domain: 'example.com', future: true }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const ir = await executeAlphaSearch({
    dispatcher: call,
    sessionId: 'session-search',
    commands: { search_query: [{ q: 'Floway' }] },
    settings: { external_web_access: true },
    input: [{ type: 'message', role: 'user', content: 'Search' }],
    action: { type: 'search', query: 'Floway' },
    signal: undefined,
  });

  assertEquals(ir.outputText, 'rendered output');
  assertEquals(ir.results, [{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: 'rendered output' }]);
  assertEquals(call.mock.calls[0]?.[0], {
    id: 'session-search',
    input: [{ type: 'message', role: 'user', content: 'Search' }],
    commands: { search_query: [{ q: 'Floway' }] },
    settings: { external_web_access: true },
  });
});

test('executeAlphaSearch exposes upstream failure without fallback', async () => {
  await expect(executeAlphaSearch({
    dispatcher: async () => new Response('unavailable', { status: 503 }),
    sessionId: 'session-search',
    commands: { search_query: [{ q: 'Floway' }] },
    settings: {},
    input: [],
    action: { type: 'search', query: 'Floway' },
    signal: undefined,
  })).rejects.toThrow('HTTP 503');
});

test('executeAlphaSearch returns a cascaded Floway capability error as exact model-facing output', async () => {
  const message = 'The configured web search provider does not implement OpenAI search feature `commands.image_query`.';
  const ir = await executeAlphaSearch({
    dispatcher: async () => new Response(JSON.stringify({
      error: {
        type: 'internal_error',
        name: 'UnsupportedLocalWebSearchFeatureError',
        message,
      },
    }), { status: 500, headers: { 'content-type': 'application/json' } }),
    sessionId: 'session-search',
    commands: { image_query: [{ q: 'cat' }] },
    settings: {},
    input: [],
    action: { type: 'search', query: 'image_query' },
    signal: undefined,
  });
  assertEquals(ir.outputText, message);
  assertEquals(ir.results, [{
    type: 'text_result',
    url: '',
    title: 'Unsupported search feature',
    snippet: message,
  }]);
});
