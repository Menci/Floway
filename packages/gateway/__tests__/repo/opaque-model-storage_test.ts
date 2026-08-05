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

test('opaque model storage migration preserves existing embedded-NUL dimensions', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename !== MIGRATION) {
        db.run(sql);
        continue;
      }

      for (const row of [
        { model: 'a\0b', upstream: 'c', modelKey: 'd', metric: 'input_tokens', quantity: '1', requests: 1 },
        { model: 'a', upstream: 'b', modelKey: 'c\0d', metric: 'output_tokens', quantity: '2', requests: 2 },
      ]) {
        db.run(
          `INSERT INTO usage (
             key_id, model, upstream, model_key, hour, pricing_selector,
             metric, quantity, unit_price
           ) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, NULL)`,
          ['key-nul', row.model, row.upstream, row.modelKey, '2026-08-06T00', row.metric, row.quantity],
        );
        db.run(
          `INSERT INTO usage_requests (
             key_id, model, upstream, model_key, hour, pricing_selector, requests
           ) VALUES (?, ?, ?, ?, ?, '{}', ?)`,
          ['key-nul', row.model, row.upstream, row.modelKey, '2026-08-06T00', row.requests],
        );
      }
      db.run(
        `INSERT INTO performance_summary (
           hour, key_id, model, upstream, operation, runtime_location,
           requests, neutral
         ) VALUES (?, ?, ?, ?, 'chat', 'LOCAL', 1, 1)`,
        ['2026-08-06T00', 'key-nul', 'performance\0model', 'up-nul'],
      );
      db.run('UPDATE search_config SET alpha_search_model = ?', ['search\0model']);

      db.run(sql);
      const repo = new SqlRepo(wrapSqlJsDatabase(db));
      const usage = await repo.usage.listAll();
      assertEquals(usage.length, 2);
      assertEquals(usage.find(record => record.model === 'a\0b'), {
        keyId: 'key-nul',
        model: 'a\0b',
        upstream: 'c',
        modelKey: 'd',
        hour: '2026-08-06T00',
        pricingSelector: {},
        requests: 1,
        metrics: [{ metric: 'input_tokens', quantity: '1', unitPrice: null }],
      });
      assertEquals(usage.find(record => record.model === 'a'), {
        keyId: 'key-nul',
        model: 'a',
        upstream: 'b',
        modelKey: 'c\0d',
        hour: '2026-08-06T00',
        pricingSelector: {},
        requests: 2,
        metrics: [{ metric: 'output_tokens', quantity: '2', unitPrice: null }],
      });
      assertEquals((await repo.performance.listAll())[0]?.model, 'performance\0model');
      const searchConfig = await repo.webSearchConfig.get() as {
        passthroughOpenAiSearch: { model: string };
      };
      assertEquals(searchConfig.passthroughOpenAiSearch.model, 'search\0model');

      const stored = db.exec('SELECT model_json, model_key_json FROM usage ORDER BY rowid')[0];
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
