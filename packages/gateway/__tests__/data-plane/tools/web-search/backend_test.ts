import { expect, test } from 'vitest';

import { resolveConfiguredWebSearchBackend, testWebSearchConfigConnection } from '../../../../src/data-plane/tools/web-search/backend.ts';
import { DEFAULT_WEB_SEARCH_CONFIG, FIXED_WEB_SEARCH_CONFIG_TEST_QUERY } from '../../../../src/data-plane/tools/web-search/config.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('resolveConfiguredWebSearchBackend returns disabled, missing-credential, or enabled', () => {
  assertEquals(resolveConfiguredWebSearchBackend(DEFAULT_WEB_SEARCH_CONFIG), {
    type: 'disabled',
  });

  assertEquals(
    resolveConfiguredWebSearchBackend({
      backend: 'tavily',
      tavily: { apiKey: '' },
      microsoftWebIq: { apiKey: 'ms-test' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    }),
    {
      type: 'missing-credential',
      backend: 'tavily',
    },
  );

  const resolved = resolveConfiguredWebSearchBackend({
    backend: 'microsoft-web-iq',
    tavily: { apiKey: 'tvly-test' },
    microsoftWebIq: { apiKey: 'ms-test' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(resolved.type, 'enabled');
  if (resolved.type !== 'enabled') {
    throw new Error('expected enabled provider');
  }
  assertEquals(resolved.backend, 'microsoft-web-iq');
});

test('testWebSearchConfigConnection returns structured disabled and missing-credential errors', async () => {
  expect(await testWebSearchConfigConnection(DEFAULT_WEB_SEARCH_CONFIG)).toMatchObject({
    ok: false,
    backend: 'disabled',
    query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
    error: {
      code: 'disabled',
    },
  });

  expect(
    await testWebSearchConfigConnection({
      backend: 'tavily',
      tavily: { apiKey: '' },
      microsoftWebIq: { apiKey: 'ms-test' },
      jina: { apiKey: '' },
      passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
    }),
  ).toMatchObject(
    {
      ok: false,
      backend: 'tavily',
      query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'missing_credential',
      },
    },
  );
});
