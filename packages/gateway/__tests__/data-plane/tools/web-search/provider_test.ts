import { test } from 'vitest';

import { DEFAULT_WEB_SEARCH_CONFIG, FIXED_WEB_SEARCH_CONFIG_TEST_QUERY } from '../../../../src/data-plane/tools/web-search/config.ts';
import { resolveConfiguredWebSearchProvider, testWebSearchConfigConnection } from '../../../../src/data-plane/tools/web-search/provider.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

test('resolveConfiguredWebSearchProvider returns disabled, missing-credential, or enabled', () => {
  assertEquals(resolveConfiguredWebSearchProvider(DEFAULT_WEB_SEARCH_CONFIG), {
    type: 'disabled',
  });

  assertEquals(
    resolveConfiguredWebSearchProvider({
      provider: 'tavily',
      tavily: { apiKey: '' },
      microsoftWebIq: { apiKey: 'ms-test' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    }),
    {
      type: 'missing-credential',
      provider: 'tavily',
    },
  );

  const resolved = resolveConfiguredWebSearchProvider({
    provider: 'microsoft-web-iq',
    tavily: { apiKey: 'tvly-test' },
    microsoftWebIq: { apiKey: 'ms-test' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(resolved.type, 'enabled');
  if (resolved.type !== 'enabled') {
    throw new Error('expected enabled provider');
  }
  assertEquals(resolved.provider, 'microsoft-web-iq');
});

test('testWebSearchConfigConnection returns structured disabled and missing-credential errors', async () => {
  assertEquals(await testWebSearchConfigConnection(DEFAULT_WEB_SEARCH_CONFIG), {
    ok: false,
    provider: 'disabled',
    query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
    error: {
      code: 'disabled',
      message: 'Search provider is disabled.',
    },
  });

  assertEquals(
    await testWebSearchConfigConnection({
      provider: 'tavily',
      tavily: { apiKey: '' },
      microsoftWebIq: { apiKey: 'ms-test' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    }),
    {
      ok: false,
      provider: 'tavily',
      query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'missing_credential',
        message: 'Missing API key for tavily.',
      },
    },
  );
});

test('testWebSearchConfigConnection previews at most three normalized results', async () => {
  await withMockedFetch(
    () =>
      jsonResponse({
        results: [
          {
            title: 'React A',
            url: 'https://react.dev/a',
            content: 'A'.repeat(400),
            published_date: '2026-04-01T00:00:00Z',
          },
          {
            title: 'React B',
            url: 'https://react.dev/b',
            content: 'Second result',
          },
          {
            title: 'React C',
            url: 'https://react.dev/c',
            content: 'Third result',
          },
          {
            title: 'React D',
            url: 'https://react.dev/d',
            content: 'Fourth result',
          },
        ],
      }),
    async () => {
      const result = await testWebSearchConfigConnection({
        provider: 'tavily',
        tavily: { apiKey: 'tvly-test' },
        microsoftWebIq: { apiKey: 'ms-test' },
        jina: { apiKey: '' },
        passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
      });

      assertEquals(result.ok, true);
      if (!result.ok) {
        throw new Error('expected a successful preview result');
      }

      assertEquals(result.provider, 'tavily');
      assertEquals(result.query, FIXED_WEB_SEARCH_CONFIG_TEST_QUERY);
      assertEquals(result.results.length, 3);
      assertEquals(result.results[0].title, 'React A');
      assertEquals(result.results[0].url, 'https://react.dev/a');
      assertEquals(result.results[0].pageAge, '2026-04-01T00:00:00Z');
      assertEquals(result.results[0].previewText.length, 280);
      assertEquals(result.results[2].title, 'React C');
    },
  );
});
