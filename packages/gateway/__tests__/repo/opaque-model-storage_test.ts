import { test } from 'vitest';

import { createSqlJsDatabase, migrationSqlByFilename, wrapSqlJsDatabase } from './test-sqlite.ts';
import { decodeOpaqueSqlText, encodeOpaqueSqlText } from '../../src/repo/opaque-sql-text.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const MIGRATION = '0077_opaque_model_storage.sql';

test('opaque SQL text codec is a reversible JSON string representation', () => {
  for (const value of ['', 'plain', 'nul\0inside', 'snow-雪', '\ud800']) {
    const encoded = encodeOpaqueSqlText(value);
    assertEquals(encoded.includes('\0'), false);
    assertEquals(decodeOpaqueSqlText(encoded, 'test value'), value);
  }
});

test('opaque SQL text codec rejects malformed and non-string stored values with context', () => {
  assertThrows(() => decodeOpaqueSqlText('not-json', 'usage.model_json'), Error, 'usage.model_json is malformed');
  assertThrows(() => decodeOpaqueSqlText('42', 'usage.model_json'), Error, 'usage.model_json is invalid');
});

test('opaque model storage migration converts existing rows and enables embedded-NUL dimensions', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename !== MIGRATION) {
        db.run(sql);
        continue;
      }

      db.run(
        `INSERT INTO usage (
           key_id, model, upstream, model_key, hour, pricing_selector,
           metric, quantity, unit_price
         ) VALUES (?, ?, ?, ?, ?, '{}', 'input_tokens', '3', NULL)`,
        ['key-legacy', 'legacy-model', 'up-legacy', 'legacy-model-key', '2026-08-05T00'],
      );
      db.run(
        `INSERT INTO usage_requests (
           key_id, model, upstream, model_key, hour, pricing_selector, requests
         ) VALUES (?, ?, ?, ?, ?, '{}', 4)`,
        ['key-legacy', 'legacy-model', 'up-legacy', 'legacy-model-key', '2026-08-05T00'],
      );
      db.run(
        `INSERT INTO performance_summary (
           hour, key_id, model, upstream, operation, runtime_location,
           requests, neutral
         ) VALUES (?, ?, ?, ?, 'chat', 'LOCAL', 1, 1)`,
        ['2026-08-05T00', 'key-legacy', 'legacy-performance-model', 'up-legacy'],
      );
      db.run('UPDATE search_config SET alpha_search_model = ?', ['legacy-search-model']);

      db.run(sql);
      const repo = new SqlRepo(wrapSqlJsDatabase(db));
      assertEquals((await repo.usage.listAll())[0], {
        keyId: 'key-legacy',
        model: 'legacy-model',
        upstream: 'up-legacy',
        modelKey: 'legacy-model-key',
        hour: '2026-08-05T00',
        pricingSelector: {},
        requests: 4,
        metrics: [{ metric: 'input_tokens', quantity: '3', unitPrice: null }],
      });
      assertEquals((await repo.performance.listAll())[0]?.model, 'legacy-performance-model');
      assertEquals(
        (await repo.webSearchConfig.get() as { passthroughOpenAiSearch: { model: string } })
          .passthroughOpenAiSearch.model,
        'legacy-search-model',
      );

      await repo.usage.set({
        keyId: 'key-nul',
        model: 'a\0b',
        upstream: 'c',
        modelKey: 'd',
        hour: '2026-08-06T00',
        pricingSelector: {},
        requests: 1,
        metrics: [{ metric: 'input_tokens', quantity: '1', unitPrice: null }],
      });
      await repo.usage.set({
        keyId: 'key-nul',
        model: 'a',
        upstream: 'b',
        modelKey: 'c\0d',
        hour: '2026-08-06T00',
        pricingSelector: {},
        requests: 2,
        metrics: [{ metric: 'output_tokens', quantity: '2', unitPrice: null }],
      });
      await repo.performance.recordNeutral({
        hour: '2026-08-06T00',
        keyId: 'key-nul',
        model: 'performance\0model',
        upstream: 'up-nul',
        operation: 'chat',
        runtimeLocation: 'LOCAL',
      });
      await repo.webSearchConfig.save({
        provider: 'disabled',
        tavily: { apiKey: '' },
        microsoftWebIq: { apiKey: '' },
        jina: { apiKey: '' },
        passthroughOpenAiSearch: {
          enabled: true,
          upstreamId: 'up-nul',
          model: 'search\0model',
        },
      });

      const usage = (await repo.usage.listAll()).filter(record => record.keyId === 'key-nul');
      assertEquals(usage.length, 2);
      assertEquals(usage.find(record => record.model === 'a\0b')?.modelKey, 'd');
      assertEquals(usage.find(record => record.model === 'a')?.modelKey, 'c\0d');
      assertEquals((await repo.performance.listAll()).find(record => record.keyId === 'key-nul')?.model, 'performance\0model');
      assertEquals(
        (await repo.webSearchConfig.get() as { passthroughOpenAiSearch: { model: string } })
          .passthroughOpenAiSearch.model,
        'search\0model',
      );

      const stored = db.exec("SELECT model_json, model_key_json FROM usage WHERE key_id = 'key-nul' ORDER BY rowid")[0];
      assertEquals(stored!.values, [
        [JSON.stringify('a\0b'), JSON.stringify('d')],
        [JSON.stringify('a'), JSON.stringify('c\0d')],
      ]);
      return;
    }
    throw new Error(`Missing migration ${MIGRATION}`);
  } finally {
    db.close();
  }
});
