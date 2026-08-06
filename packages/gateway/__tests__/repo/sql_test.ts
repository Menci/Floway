import { test } from 'vitest';

import { seedModelsCache, seedModelsCacheError } from './models-cache-fixture.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { MODEL_CATALOG_REVISION } from '../../src/data-plane/providers/models-cache.ts';
import { modelsCacheGeneration } from '../../src/repo/models-cache-contract.ts';
import { SqlRepo, UPSTREAM_STATE_WRITE_ATTEMPTS } from '../../src/repo/sql.ts';
import type { SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, stubProviderModel } from '@floway-dev/test-utils';

const goodAccount = { chatgptAccountId: 'aid', refresh_token: 'rt_v1', state: 'active' as const, state_updated_at: '2026-01-01T00:00:00Z' };
const GENERATION = '2026-06-05T00:00:00.000Z';
const baseRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_test',
  kind: 'codex',
  name: 'Codex Test',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-05T00:00:00.000Z',
  updatedAt: GENERATION,
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'aid', chatgptUserId: 'uid', planType: 'plus' }] },
  state: { accounts: [goodAccount] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  configVersion: 1,
  modelsCache: null,
  hue: 210,
  ...overrides,
});
const generationFor = modelsCacheGeneration;

const ownValue = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
    throw new Error(`Expected own property ${JSON.stringify(key)}`);
  }
  return Reflect.get(value, key);
};

test('SQL upstream repo preserves nested own __proto__ fields in opaque config and state', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord({
    config: JSON.parse('{"nested":{"__proto__":{"marker":"config"}}}'),
    state: JSON.parse('{"nested":{"__proto__":{"marker":"state"}}}'),
  }));

  const stored = await repo.getById('up_test');
  assertEquals(ownValue(ownValue(ownValue(stored?.config, 'nested'), '__proto__'), 'marker'), 'config');
  assertEquals(ownValue(ownValue(ownValue(stored?.state, 'nested'), '__proto__'), 'marker'), 'state');
});

test('SQL upstream repo round-trips the cached catalog and its revision', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await seedModelsCache(repo, 'up_test', generationFor(baseRecord()), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  const cached = (await repo.getById('up_test'))?.modelsCache;
  assertEquals(cached?.revision, MODEL_CATALOG_REVISION);
  assertEquals(cached?.fetchedAt, 1_700_000_000_000);
  assertEquals(cached?.models.map(model => model.id), ['cached-model']);
  assertEquals(cached?.lastError, null);
});

test('SQL upstream repo rejects shape-invalid JSON in a cached catalog with row context', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await repo.save(baseRecord());
  await db.prepare('UPDATE upstreams SET models_cache_json = ? WHERE id = ?')
    .bind(JSON.stringify({
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: 1_700_000_000_000,
      models: [{ id: 42 }],
      lastError: null,
    }), 'up_test')
    .run();

  await assertRejects(
    () => repo.getById('up_test'),
    Error,
    'Invalid upstream models cache JSON for up_test: models.0.id',
  );
});

test('SQL upstream repo preserves opaque provider data while restoring only the model enabledFlags Set', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await seedModelsCache(repo, 'up_test', generationFor(baseRecord()), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({
      id: 'cached-model',
      providerData: JSON.parse('{"enabledFlags":["provider-private"],"future":{"__proto__":{"marker":"provider"}}}'),
    })],
  });

  const model = (await repo.getById('up_test'))?.modelsCache?.models[0];
  assertEquals(model?.enabledFlags instanceof Set, true);
  assertEquals(ownValue(model?.providerData, 'enabledFlags'), ['provider-private']);
  assertEquals(ownValue(ownValue(ownValue(model?.providerData, 'future'), '__proto__'), 'marker'), 'provider');
});

test('SQL upstream repo hydrates deeply nested opaque provider data without recursively copying it', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await repo.save(baseRecord());
  const depth = 20_000;
  const providerData = `${'{"next":'.repeat(depth)}null${'}'.repeat(depth)}`;
  const cache = `{"revision":${MODEL_CATALOG_REVISION},"fetchedAt":1700000000000,"models":[{"id":"deep-model","limits":{},"kind":"chat","endpoints":{"responses":{}},"providerData":${providerData},"enabledFlags":[]}],"lastError":null}`;
  await db.prepare('UPDATE upstreams SET models_cache_json = ? WHERE id = ?').bind(cache, 'up_test').run();

  const model = (await repo.getById('up_test'))?.modelsCache?.models[0];
  assertEquals(model?.id, 'deep-model');
  assertEquals(ownValue(model?.providerData, 'next') !== undefined, true);
});

test('SQL upstream repo annotates a cached catalog and successful publication clears the error', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await seedModelsCache(repo, 'up_test', generationFor(baseRecord()), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  await seedModelsCacheError(repo, 'up_test', generationFor(baseRecord()), { message: 'boom', at: 1_700_000_500_000 });
  const annotated = (await repo.getById('up_test'))?.modelsCache;
  assertEquals(annotated?.lastError, { message: 'boom', at: 1_700_000_500_000 });
  assertEquals(annotated?.models.map(model => model.id), ['cached-model']);

  await seedModelsCache(repo, 'up_test', generationFor(baseRecord()), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_001_000_000,
    models: [stubProviderModel({ id: 'refreshed-model' })],
  });
  assertEquals((await repo.getById('up_test'))?.modelsCache?.lastError, null);
});

test('SQL upstream repo persists an immediately-stale empty catalog on first failure', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());

  await seedModelsCacheError(repo, 'up_test', generationFor(baseRecord()), { message: 'boom', at: 1_700_000_500_000 });

  assertEquals((await repo.getById('up_test'))?.modelsCache, {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 0,
    models: [],
    lastError: { message: 'boom', at: 1_700_000_500_000 },
  });
});

test('SQL upstream repo catalog-aware replacement can clear the cached catalog atomically', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await seedModelsCache(repo, 'up_test', generationFor(baseRecord()), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  const newIdentity = baseRecord({
    name: 'New identity',
    config: { accounts: [{ email: 'new@example.com', chatgptAccountId: 'new-account', chatgptUserId: 'new-user', planType: 'plus' }] },
  });
  await repo.replaceForModels({ previous: baseRecord(), upstream: newIdentity });

  const stored = await repo.getById('up_test');
  assertEquals(stored?.name, 'New identity');
  assertEquals(stored?.modelsCache, null);

  const staleCatalogSaved = await seedModelsCache(repo, 'up_test', generationFor(baseRecord()), {
    revision: 7,
    fetchedAt: 1_700_001_000_000,
    models: [stubProviderModel({ id: 'stale-model' })],
  });
  const staleErrorSaved = await seedModelsCacheError(repo, 'up_test', generationFor(baseRecord()), { message: 'stale error', at: 1_700_001_000_000 });
  assertEquals(staleCatalogSaved, false);
  assertEquals(staleErrorSaved, false);
  assertEquals((await repo.getById('up_test'))?.modelsCache, null);
});

test('SQL model-cache generation accepts semantically equal noncanonical config JSON', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  const record = baseRecord();
  await repo.save(record);
  const noncanonicalConfig = `{ "accounts": ${JSON.stringify((record.config as { accounts: unknown }).accounts)} }`;
  await db.prepare('UPDATE upstreams SET config_json = ? WHERE id = ?').bind(noncanonicalConfig, record.id).run();
  const parsed = await repo.getById(record.id);
  if (!parsed) throw new Error('upstream row missing');

  const saved = await seedModelsCache(repo, record.id, generationFor(parsed), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_001_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  assertEquals(saved, true);
  assertEquals((await repo.getById(record.id))?.modelsCache?.models.map(model => model.id), ['cached-model']);
});

test('SQL upstream repo save leaves an existing cached catalog alone', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await seedModelsCache(repo, 'up_test', generationFor(baseRecord()), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  // An operator edit carries whatever catalog the request happened to read —
  // here, none at all. The refresh path stays the only writer.
  await repo.save(baseRecord({ name: 'Renamed', modelsCache: null }));

  const record = await repo.getById('up_test');
  assertEquals(record?.name, 'Renamed');
  assertEquals(record?.modelsCache?.models.map(model => model.id), ['cached-model']);
});

test('SQL rejects malformed persisted model refresh state', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await repo.save(baseRecord());

  await assertRejects(
    () => db.prepare('UPDATE upstreams SET models_refresh_json = ? WHERE id = ?')
      .bind(JSON.stringify({ failCount: 0, retryAt: 0, claimToken: 'owner', claimedAt: null }), 'up_test')
      .run(),
  );
});

test('SQL upstream repo round-trips state_json on save/list/getById', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  const original = baseRecord();
  await repo.save(original);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [goodAccount] });
  assertEquals((await repo.list())[0].state, { accounts: [goodAccount] });
});

test('SQL upstream repo saveState applies the mutator to the stored state', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await repo.saveState('up_test', current => {
    assertEquals(current, { accounts: [goodAccount] });
    return { accounts: [{ ...goodAccount, refresh_token: 'rt_v2' }] };
  });
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [{ ...goodAccount, refresh_token: 'rt_v2' }] });
});

// Deterministic stand-in for a concurrent writer: each of the first `times`
// reads of `state_json` lands an out-of-band write before returning, so that
// many CAS attempts are guaranteed to lose. Without this neither the retry nor
// the exhaustion path is reachable from a single-threaded test.
const withWriterRacingReads = (db: SqlDatabase, race: () => Promise<unknown>, times: number): SqlDatabase => {
  let raced = 0;
  const wrapStatement = (statement: SqlPreparedStatement, racing: boolean): SqlPreparedStatement => ({
    bind: (...values) => wrapStatement(statement.bind(...values), racing),
    all: <T>() => statement.all<T>(),
    run: () => statement.run(),
    first: async <T>() => {
      const row = await statement.first<T>();
      if (racing && raced < times) {
        raced += 1;
        await race();
      }
      return row;
    },
  });
  return {
    prepare: query => wrapStatement(db.prepare(query), query.startsWith('SELECT state_json')),
    exec: sql => db.exec(sql),
  };
};

// The reason the change is a function rather than a document: the writer whose
// read was invalidated re-derives its change from the state that won, so both
// survive. A caller that had computed its document up front would instead
// reinstate the value the winner replaced.
test('SQL upstream repo saveState re-applies the mutator against the write that won', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await repo.save(baseRecord());
  const racing = new SqlRepo(withWriterRacingReads(db, () =>
    db.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?')
      .bind(JSON.stringify({ accounts: [{ ...goodAccount, state_message: 'written by a sibling' }] }), 'up_test')
      .run(), 1)).upstreams;

  const seen: string[] = [];
  await racing.saveState('up_test', current => {
    const [account] = (current as { accounts: { state_message?: string }[] }).accounts;
    seen.push(account.state_message ?? '(none)');
    return { accounts: [{ ...account, refresh_token: 'rt_v2' }] };
  });

  // First attempt read the pre-race state, the retry read the sibling's.
  assertEquals(seen, ['(none)', 'written by a sibling']);
  const stored = (await repo.getById('up_test'))?.state as { accounts: { refresh_token: string; state_message?: string }[] };
  assertEquals(stored.accounts[0].refresh_token, 'rt_v2');
  assertEquals(stored.accounts[0].state_message, 'written by a sibling');
});

// A writer that never wins gives up rather than looping, and says so instead
// of reporting a flag a caller could drop.
test('SQL upstream repo saveState gives up after a bounded number of lost races', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db).upstreams;
  await repo.save(baseRecord());
  let siblingWrites = 0;
  const racing = new SqlRepo(withWriterRacingReads(db, () => {
    siblingWrites += 1;
    return db.prepare('UPDATE upstreams SET state_json = ? WHERE id = ?')
      .bind(JSON.stringify({ accounts: [{ ...goodAccount, state_message: `sibling ${siblingWrites}` }] }), 'up_test')
      .run();
  }, Number.MAX_SAFE_INTEGER)).upstreams;

  let attempts = 0;
  await assertRejects(
    () => racing.saveState('up_test', current => {
      attempts += 1;
      const [account] = (current as { accounts: Record<string, unknown>[] }).accounts;
      return { accounts: [{ ...account, refresh_token: 'rt_v2' }] };
    }),
    Error,
    'consecutive races',
  );
  // Every attempt ran the mutator, and none of them landed.
  assertEquals(attempts, UPSTREAM_STATE_WRITE_ATTEMPTS);
  const stored = (await repo.getById('up_test'))?.state as { accounts: { refresh_token: string }[] };
  assertEquals(stored.accounts[0].refresh_token, goodAccount.refresh_token);
});

test('SQL upstream repo saveState throws when the row is gone', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await assertRejects(() => repo.saveState('up_missing', current => current), Error, 'disappeared');
});

// A mutator that decided there is nothing to do hands back what it was given.
test('SQL upstream repo saveState skips the write when the mutator changes nothing', async () => {
  const repo = new SqlRepo(await createSqliteTestDb()).upstreams;
  await repo.save(baseRecord());
  await repo.saveState('up_test', current => current);
  assertEquals((await repo.getById('up_test'))?.state, { accounts: [goodAccount] });
});

// sql.js gives us real SQLite semantics in-process (including `IS NULL`
// comparison required for the CAS predicate). The createSqliteTestDb helper
// applies every migration so SqlRepo runs end-to-end against the same SQL
// the production platforms execute.
