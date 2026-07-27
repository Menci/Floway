import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { createNodeSqliteDatabase } from '../src/node-sqlite-database.ts';
import { SqliteImageCacheStore } from '../src/sqlite-image-cache-store.ts';
import type { ImageCachePolicy } from '@floway-dev/platform';
import { assert, assertEquals } from '@floway-dev/test-utils';

const POLICY: ImageCachePolicy = {
  ttlMs: 24 * 60 * 60 * 1000,
  refreshIfOlderThanMs: 18 * 60 * 60 * 1000,
};

const withCache = async (fn: (cache: SqliteImageCacheStore, db: ReturnType<typeof createNodeSqliteDatabase>) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'sqlite-image-cache-store-'));
  try {
    const db = createNodeSqliteDatabase(join(dir, 'test.db'));
    await db.exec(
      'CREATE TABLE image_cache ('
      + '  key TEXT PRIMARY KEY,'
      + '  value BLOB NOT NULL,'
      + '  expires_at INTEGER NOT NULL,'
      + '  last_refreshed_at INTEGER NOT NULL'
      + ')',
    );
    await fn(new SqliteImageCacheStore(db, POLICY), db);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('put writes value, expires_at, and last_refreshed_at', () => withCache(async (cache, db) => {
  const before = Date.now();
  await cache.put('k', new Uint8Array([1, 2, 3]));
  const after = Date.now();

  const row = await db
    .prepare('SELECT value, expires_at, last_refreshed_at FROM image_cache WHERE key = ?')
    .bind('k')
    .first<{ value: Uint8Array; expires_at: number; last_refreshed_at: number }>();
  assert(row !== null);
  assertEquals([...row!.value], [1, 2, 3]);
  assert(row!.last_refreshed_at >= before && row!.last_refreshed_at <= after);
  assertEquals(row!.expires_at - row!.last_refreshed_at, POLICY.ttlMs);
}));

test('get hit younger than the refresh threshold returns the value without rewriting last_refreshed_at', () => withCache(async (cache, db) => {
  await cache.put('k', new Uint8Array([7]));
  const original = await db
    .prepare('SELECT last_refreshed_at FROM image_cache WHERE key = ?')
    .bind('k')
    .first<{ last_refreshed_at: number }>();

  const hit = await cache.get('k');
  assertEquals([...hit!], [7]);

  const after = await db
    .prepare('SELECT last_refreshed_at FROM image_cache WHERE key = ?')
    .bind('k')
    .first<{ last_refreshed_at: number }>();
  assertEquals(after!.last_refreshed_at, original!.last_refreshed_at);
}));

test('get hit older than the refresh threshold rewrites last_refreshed_at and expires_at', () => withCache(async (cache, db) => {
  await cache.put('k', new Uint8Array([9]));
  // Backdate the entry so its age exceeds the threshold.
  const aged = Date.now() - 20 * 60 * 60 * 1000;
  await db.prepare('UPDATE image_cache SET last_refreshed_at = ? WHERE key = ?').bind(aged, 'k').run();

  const before = Date.now();
  const hit = await cache.get('k');
  const after = Date.now();
  assertEquals([...hit!], [9]);

  const row = await db
    .prepare('SELECT expires_at, last_refreshed_at FROM image_cache WHERE key = ?')
    .bind('k')
    .first<{ expires_at: number; last_refreshed_at: number }>();
  assert(row!.last_refreshed_at >= before && row!.last_refreshed_at <= after);
  assertEquals(row!.expires_at - row!.last_refreshed_at, POLICY.ttlMs);
}));

test('get hit on a legacy row with last_refreshed_at = 0 self-heals into a fresh timestamp', () => withCache(async (cache, db) => {
  // Mirror how migration 0032 backfills pre-existing rows.
  const future = Date.now() + POLICY.ttlMs;
  await db
    .prepare('INSERT INTO image_cache (key, value, expires_at, last_refreshed_at) VALUES (?, ?, ?, 0)')
    .bind('legacy', new Uint8Array([5]), future)
    .run();

  const before = Date.now();
  const hit = await cache.get('legacy');
  const after = Date.now();
  assertEquals([...hit!], [5]);

  const row = await db
    .prepare('SELECT last_refreshed_at FROM image_cache WHERE key = ?')
    .bind('legacy')
    .first<{ last_refreshed_at: number }>();
  assert(row!.last_refreshed_at >= before && row!.last_refreshed_at <= after);
}));

test('get returns null and skips refresh once an entry has expired', () => withCache(async (cache, db) => {
  await cache.put('k', new Uint8Array([1]));
  await db.prepare('UPDATE image_cache SET expires_at = ? WHERE key = ?').bind(Date.now() - 1000, 'k').run();

  const miss = await cache.get('k');
  assertEquals(miss, null);
}));

test('sweepExpired drops only rows with expires_at <= now', () => withCache(async (cache, db) => {
  await cache.put('fresh', new Uint8Array([1]));
  await cache.put('stale', new Uint8Array([2]));
  await db.prepare('UPDATE image_cache SET expires_at = ? WHERE key = ?').bind(Date.now() - 1000, 'stale').run();

  await cache.sweepExpired(Date.now());

  const remaining = await db.prepare('SELECT key FROM image_cache ORDER BY key').all<{ key: string }>();
  assertEquals(remaining.results.map(r => r.key), ['fresh']);
}));
