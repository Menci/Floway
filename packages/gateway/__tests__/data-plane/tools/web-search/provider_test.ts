import { expect, test } from 'vitest';

import { DEFAULT_WEB_SEARCH_CONFIG, FIXED_WEB_SEARCH_CONFIG_TEST_QUERY } from '../../../../src/data-plane/tools/web-search/config.ts';
import { resolveConfiguredWebSearchProvider, testWebSearchConfigConnection } from '../../../../src/data-plane/tools/web-search/provider.ts';
import { assertEquals } from '@floway-dev/test-utils';

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
  expect(await testWebSearchConfigConnection(DEFAULT_WEB_SEARCH_CONFIG)).toMatchObject({
    ok: false,
    provider: 'disabled',
    query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
    error: {
      code: 'disabled',
    },
  });

  expect(
    await testWebSearchConfigConnection({
      provider: 'tavily',
      tavily: { apiKey: '' },
      microsoftWebIq: { apiKey: 'ms-test' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    }),
  ).toMatchObject(
    {
      ok: false,
      provider: 'tavily',
      query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'missing_credential',
      },
    },
  );
});
