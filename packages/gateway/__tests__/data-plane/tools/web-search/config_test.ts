import { test } from 'vitest';

import { DEFAULT_WEB_SEARCH_CONFIG, FIXED_WEB_SEARCH_CONFIG_TEST_QUERY, loadWebSearchConfig, parseWebSearchConfigDefault, parseWebSearchConfigStrict, saveWebSearchConfig } from '../../../../src/data-plane/tools/web-search/config.ts';
import type { WebSearchConfig } from '../../../../src/data-plane/tools/web-search/types.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { SqlRepo } from '../../../../src/repo/sql.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createSqliteTestDb } from '../../../repo/test-sqlite.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertEquals, assertRejects, assertThrows } from '@floway-dev/test-utils';

interface WebSearchConfigRow {
  provider: string;
  tavily_api_key: string;
  microsoft_web_iq_api_key: string;
  jina_api_key: string;
  passthrough_openai_search: number;
  alpha_search_upstream_id: string;
  alpha_search_model: string;
}

const SELECT_SQL = 'SELECT provider, tavily_api_key, microsoft_web_iq_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model FROM search_config WHERE id = 1';
const UPSERT_SQL = `INSERT INTO search_config (id, provider, tavily_api_key, microsoft_web_iq_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           tavily_api_key = excluded.tavily_api_key,
           microsoft_web_iq_api_key = excluded.microsoft_web_iq_api_key,
           jina_api_key = excluded.jina_api_key,
           passthrough_openai_search = excluded.passthrough_openai_search,
           alpha_search_upstream_id = excluded.alpha_search_upstream_id,
           alpha_search_model = excluded.alpha_search_model,
           updated_at = excluded.updated_at`;

class FakeSqlPreparedStatement {
  private binds: unknown[] = [];

  constructor(private db: FakeSqlDatabase, private query: string) {}

  bind(...values: unknown[]): FakeSqlPreparedStatement {
    this.binds = values;
    return this;
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.query === SELECT_SQL) {
      return Promise.resolve(this.db.webSearchConfig === null ? null : ({ ...this.db.webSearchConfig } as T));
    }

    throw new Error(`Unsupported first() query in test: ${this.query}`);
  }

  all(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    throw new Error(`Unsupported all() query in test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query === UPSERT_SQL) {
      this.db.webSearchConfig = {
        provider: String(this.binds[0]),
        tavily_api_key: String(this.binds[1]),
        microsoft_web_iq_api_key: String(this.binds[2]),
        jina_api_key: String(this.binds[3]),
        passthrough_openai_search: Number(this.binds[4]),
        alpha_search_upstream_id: String(this.binds[5]),
        alpha_search_model: String(this.binds[6]),
      };
      return Promise.resolve({ results: [], success: true, meta: {} });
    }

    throw new Error(`Unsupported run() query in test: ${this.query}`);
  }
}

class FakeSqlDatabase implements SqlDatabase {
  exec(): Promise<unknown> { return Promise.resolve(undefined); }

  webSearchConfig: WebSearchConfigRow | null = null;

  prepare(query: string): FakeSqlPreparedStatement {
    return new FakeSqlPreparedStatement(this, query);
  }
}

test('search config repo defaults to disabled and round-trips provider keys', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  assertEquals(await loadWebSearchConfig(), DEFAULT_WEB_SEARCH_CONFIG);

  await saveWebSearchConfig({
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftWebIq: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(await loadWebSearchConfig(), {
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftWebIq: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
  assertEquals(FIXED_WEB_SEARCH_CONFIG_TEST_QUERY, 'React documentation');
});

test('loadWebSearchConfig strict-parses a stored row and rejects unknown provider values', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await repo.webSearchConfig.save({
    provider: 'unknown-provider',
    tavily: { apiKey: '  tvly-test  ' },
    microsoftWebIq: { apiKey: '  ms-test  ' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  } as unknown as WebSearchConfig);

  await assertRejects(() => loadWebSearchConfig(), Error, 'provider');
});

test('loadWebSearchConfig strict-parses a stored row and trims valid api keys', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await repo.webSearchConfig.save({
    provider: 'jina',
    tavily: { apiKey: '  tvly-trim  ' },
    microsoftWebIq: { apiKey: '  ms-trim  ' },
    jina: { apiKey: '  jina-trim  ' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(await loadWebSearchConfig(), {
    provider: 'jina',
    tavily: { apiKey: 'tvly-trim' },
    microsoftWebIq: { apiKey: 'ms-trim' },
    jina: { apiKey: 'jina-trim' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});

test('parseWebSearchConfigDefault returns a fresh deep copy so callers cannot corrupt the singleton', () => {
  const a = parseWebSearchConfigDefault();
  const b = parseWebSearchConfigDefault();
  a.tavily.apiKey = 'mutated';
  assertEquals(b.tavily.apiKey, '');
  assertEquals(DEFAULT_WEB_SEARCH_CONFIG.tavily.apiKey, '');
});

test('parseWebSearchConfigStrict throws on missing required fields', () => {
  assertThrows(() => parseWebSearchConfigStrict({}), Error);
  assertThrows(() => parseWebSearchConfigStrict({ provider: 'disabled' }), Error);
  assertThrows(
    () => parseWebSearchConfigStrict({ provider: 'disabled', tavily: { apiKey: '' } }),
    Error,
    'microsoftWebIq',
  );
  assertThrows(
    () => parseWebSearchConfigStrict({ provider: 'disabled', tavily: {}, microsoftWebIq: { apiKey: '' }, jina: { apiKey: '' } }),
    Error,
    'tavily.apiKey',
  );
  assertThrows(
    () => parseWebSearchConfigStrict({ provider: 'disabled', tavily: { apiKey: '' }, microsoftWebIq: { apiKey: '' } }),
    Error,
    'jina',
  );
});

test('parseWebSearchConfigStrict requires upstream and model when passthrough is enabled', () => {
  assertThrows(() => parseWebSearchConfigStrict({
    ...DEFAULT_WEB_SEARCH_CONFIG,
    passthroughOpenAiSearch: { enabled: true, upstreamId: '', model: '' },
  }), Error, 'requires an upstream and model');
});

test('saveWebSearchConfig writes the typed columns and round-trips through the same db', async () => {
  const db = new FakeSqlDatabase();
  initRepo(new SqlRepo(db));

  const saved = await saveWebSearchConfig({
    provider: 'disabled',
    tavily: { apiKey: '  tvly-test  ' },
    microsoftWebIq: { apiKey: '  ms-test  ' },
    jina: { apiKey: '  jina-test  ' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(saved, {
    provider: 'disabled',
    tavily: { apiKey: 'tvly-test' },
    microsoftWebIq: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
  assertEquals(db.webSearchConfig, {
    provider: 'disabled',
    tavily_api_key: 'tvly-test',
    microsoft_web_iq_api_key: 'ms-test',
    jina_api_key: 'jina-test',
    passthrough_openai_search: 0,
    alpha_search_upstream_id: '',
    alpha_search_model: '',
  });
  assertEquals(await loadWebSearchConfig(), {
    provider: 'disabled',
    tavily: { apiKey: 'tvly-test' },
    microsoftWebIq: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});

test('current SQL schema round-trips Microsoft Web IQ configuration and usage', async () => {
  const repo = new SqlRepo(await createSqliteTestDb());
  initRepo(repo);

  const config: WebSearchConfig = {
    provider: 'microsoft-web-iq',
    tavily: { apiKey: '' },
    microsoftWebIq: { apiKey: 'web-iq-test' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  };
  await repo.webSearchConfig.save(config);
  assertEquals(await loadWebSearchConfig(), config);

  await repo.webSearchUsage.record({
    provider: 'microsoft-web-iq',
    keyId: 'key-a',
    action: 'search',
    hour: '2026-07-29T00',
    requests: 2,
  });
  assertEquals(await repo.webSearchUsage.listAll(), [{
    provider: 'microsoft-web-iq',
    keyId: 'key-a',
    action: 'search',
    hour: '2026-07-29T00',
    requests: 2,
  }]);
});
