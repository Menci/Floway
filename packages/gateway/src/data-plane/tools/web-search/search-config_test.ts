import { test } from 'vitest';

import { DEFAULT_SEARCH_CONFIG, FIXED_SEARCH_CONFIG_TEST_QUERY, loadSearchConfig, parseSearchConfigDefault, parseSearchConfigStrict, saveSearchConfig } from './search-config.ts';
import type { SearchConfig } from './types.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { SqlRepo } from '../../../repo/sql.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertEquals, assertRejects, assertThrows } from '@floway-dev/test-utils';

interface SearchConfigRow {
  provider: string;
  tavily_api_key: string;
  microsoft_grounding_api_key: string;
  jina_api_key: string;
  passthrough_openai_search: number;
  alpha_search_upstream_id: string;
  alpha_search_model: string;
}

const SELECT_SQL = 'SELECT provider, tavily_api_key, microsoft_grounding_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model FROM search_config WHERE id = 1';
const UPSERT_SQL = `INSERT INTO search_config (id, provider, tavily_api_key, microsoft_grounding_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           tavily_api_key = excluded.tavily_api_key,
           microsoft_grounding_api_key = excluded.microsoft_grounding_api_key,
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
      return Promise.resolve(this.db.searchConfig === null ? null : ({ ...this.db.searchConfig } as T));
    }

    throw new Error(`Unsupported first() query in test: ${this.query}`);
  }

  all(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    throw new Error(`Unsupported all() query in test: ${this.query}`);
  }

  run(): Promise<{ results: never[]; success: true; meta: Record<string, unknown> }> {
    if (this.query === UPSERT_SQL) {
      this.db.searchConfig = {
        provider: String(this.binds[0]),
        tavily_api_key: String(this.binds[1]),
        microsoft_grounding_api_key: String(this.binds[2]),
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

  searchConfig: SearchConfigRow | null = null;

  prepare(query: string): FakeSqlPreparedStatement {
    return new FakeSqlPreparedStatement(this, query);
  }
}

test('search config repo defaults to disabled and round-trips provider keys', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  assertEquals(await loadSearchConfig(), DEFAULT_SEARCH_CONFIG);

  await saveSearchConfig({
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(await loadSearchConfig(), {
    provider: 'tavily',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
  assertEquals(FIXED_SEARCH_CONFIG_TEST_QUERY, 'React documentation');
});

test('loadSearchConfig strict-parses a stored row and rejects unknown provider values', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await repo.searchConfig.save({
    provider: 'unknown-provider',
    tavily: { apiKey: '  tvly-test  ' },
    microsoftGrounding: { apiKey: '  ms-test  ' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  } as unknown as SearchConfig);

  await assertRejects(() => loadSearchConfig(), Error, 'provider');
});

test('loadSearchConfig strict-parses a stored row and trims valid api keys', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  await repo.searchConfig.save({
    provider: 'jina',
    tavily: { apiKey: '  tvly-trim  ' },
    microsoftGrounding: { apiKey: '  ms-trim  ' },
    jina: { apiKey: '  jina-trim  ' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(await loadSearchConfig(), {
    provider: 'jina',
    tavily: { apiKey: 'tvly-trim' },
    microsoftGrounding: { apiKey: 'ms-trim' },
    jina: { apiKey: 'jina-trim' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});

test('parseSearchConfigDefault returns a fresh deep copy so callers cannot corrupt the singleton', () => {
  const a = parseSearchConfigDefault();
  const b = parseSearchConfigDefault();
  a.tavily.apiKey = 'mutated';
  assertEquals(b.tavily.apiKey, '');
  assertEquals(DEFAULT_SEARCH_CONFIG.tavily.apiKey, '');
});

test('parseSearchConfigStrict throws on missing required fields', () => {
  assertThrows(() => parseSearchConfigStrict({}), Error);
  assertThrows(() => parseSearchConfigStrict({ provider: 'disabled' }), Error);
  assertThrows(
    () => parseSearchConfigStrict({ provider: 'disabled', tavily: { apiKey: '' } }),
    Error,
    'microsoftGrounding',
  );
  assertThrows(
    () => parseSearchConfigStrict({ provider: 'disabled', tavily: {}, microsoftGrounding: { apiKey: '' }, jina: { apiKey: '' } }),
    Error,
    'tavily.apiKey',
  );
  assertThrows(
    () => parseSearchConfigStrict({ provider: 'disabled', tavily: { apiKey: '' }, microsoftGrounding: { apiKey: '' } }),
    Error,
    'jina',
  );
});

test('parseSearchConfigStrict requires upstream and model when passthrough is enabled', () => {
  assertThrows(() => parseSearchConfigStrict({
    ...DEFAULT_SEARCH_CONFIG,
    passthroughOpenAiSearch: { enabled: true, upstreamId: '', model: '' },
  }), Error, 'requires an upstream and model');
});

test('saveSearchConfig writes the typed columns and round-trips through the same db', async () => {
  const db = new FakeSqlDatabase();
  initRepo(new SqlRepo(db));

  const saved = await saveSearchConfig({
    provider: 'disabled',
    tavily: { apiKey: '  tvly-test  ' },
    microsoftGrounding: { apiKey: '  ms-test  ' },
    jina: { apiKey: '  jina-test  ' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });

  assertEquals(saved, {
    provider: 'disabled',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
  assertEquals(db.searchConfig, {
    provider: 'disabled',
    tavily_api_key: 'tvly-test',
    microsoft_grounding_api_key: 'ms-test',
    jina_api_key: 'jina-test',
    passthrough_openai_search: 0,
    alpha_search_upstream_id: '',
    alpha_search_model: '',
  });
  assertEquals(await loadSearchConfig(), {
    provider: 'disabled',
    tavily: { apiKey: 'tvly-test' },
    microsoftGrounding: { apiKey: 'ms-test' },
    jina: { apiKey: 'jina-test' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  });
});
