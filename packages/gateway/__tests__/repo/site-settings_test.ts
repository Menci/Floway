import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { SiteSettingsRepo } from '../../src/repo/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const exerciseSiteSettingsRepo = async (repo: SiteSettingsRepo) => {
  assertEquals(await repo.get(), { name: 'Floway' });
  await repo.save({ name: 'My Gateway' });
  assertEquals(await repo.get(), { name: 'My Gateway' });
};

test('in-memory site settings repository', async () => {
  await exerciseSiteSettingsRepo(new InMemoryRepo().siteSettings);
});

test('SQL site settings repository', async () => {
  const repo = new SqlRepo(await createSqliteTestDb());
  await exerciseSiteSettingsRepo(repo.siteSettings);
});
