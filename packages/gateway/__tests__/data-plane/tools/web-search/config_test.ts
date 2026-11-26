import { test } from 'vitest';

import { DEFAULT_WEB_SEARCH_CONFIG, loadWebSearchConfig, parseWebSearchConfigStrict } from '../../../../src/data-plane/tools/web-search/config.ts';
import type { WebSearchConfig } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { SqlRepo } from '../../../../src/repo/sql.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createSqliteTestDb } from '../../../repo/test-sqlite.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('loadWebSearchConfig strict-parses a stored row and trims valid api keys', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await repo.webSearchConfig.save({
    backend: 'jina',
    tavily: { apiKey: '  tvly-trim  ' },
    microsoftWebIq: { apiKey: '  ms-trim  ' },
    jina: { apiKey: '  jina-trim  ' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(await loadWebSearchConfig(), {
    backend: 'jina',
    tavily: { apiKey: 'tvly-trim' },
    microsoftWebIq: { apiKey: 'ms-trim' },
    jina: { apiKey: 'jina-trim' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});

test('parseWebSearchConfigStrict throws on missing required fields', () => {
  assertThrows(
    () => parseWebSearchConfigStrict({ backend: 'disabled', tavily: {}, microsoftWebIq: { apiKey: '' }, jina: { apiKey: '' } }),
    Error,
  );
});

test('parseWebSearchConfigStrict requires upstream and model when passthrough is enabled', () => {
  assertThrows(() => parseWebSearchConfigStrict({
    ...DEFAULT_WEB_SEARCH_CONFIG,
    passthroughOpenAiSearch: { enabled: true, upstreamId: '', model: '' },
  }), Error);
});

test('current SQL schema round-trips Microsoft Web IQ configuration', async () => {
  const repo = new SqlRepo(await createSqliteTestDb());
  initRepo(repo);

  const config: WebSearchConfig = {
    backend: 'microsoft-web-iq',
    tavily: { apiKey: '' },
    microsoftWebIq: { apiKey: 'web-iq-test' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  };
  await repo.webSearchConfig.save(config);
  assertEquals(await loadWebSearchConfig(), config);
});
