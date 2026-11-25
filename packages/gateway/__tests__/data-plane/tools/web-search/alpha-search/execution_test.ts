import { expect, test } from 'vitest';

import { alphaSearchResultToWebSearchCall } from '../../../../../src/data-plane/tools/web-search/alpha-search/execution.ts';

test('Alpha Search preserves model-facing output and keeps opaque metadata off Responses wire results', () => {
  const result = alphaSearchResultToWebSearchCall({
    encrypted_output: 'opaque',
    output: 'rendered output',
    results: [{ type: 'text_result', ref_id: 'turn0search0', url: 'https://example.com', title: 'Example', domain: 'example.com', future: true }],
  }, 200, { type: 'search', query: 'Floway' });
  expect(result).toEqual({
    action: { type: 'search', query: 'Floway' },
    outputText: 'rendered output',
    results: [{ type: 'text_result', url: '', title: 'OpenAI search output', snippet: 'rendered output' }],
  });
});

test('Alpha Search retains the original upstream error text', () => {
  expect(() => alphaSearchResultToWebSearchCall('unavailable', 503, { type: 'search', query: 'Floway' }))
    .toThrow('OpenAI search upstream returned HTTP 503: unavailable');
});

test('Alpha Search exposes a Floway capability error as exact model-facing output', () => {
  const message = 'The configured web search provider does not implement OpenAI search feature `commands.image_query`.';
  const result = alphaSearchResultToWebSearchCall({
    error: { type: 'internal_error', name: 'UnsupportedLocalWebSearchFeatureError', message },
  }, 500, { type: 'search', query: 'image_query' });
  expect(result.outputText).toBe(message);
  expect(result.results).toEqual([{
    type: 'text_result',
    url: '',
    title: 'Unsupported search feature',
    snippet: message,
  }]);
});
