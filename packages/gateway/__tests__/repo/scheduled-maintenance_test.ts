import { expect, test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';

test('scheduled maintenance lease renews and protects a newer claimant', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);

  expect(await repo.scheduledMaintenance.tryClaim('claim-a', 10, 0)).toBe(true);
  expect(await repo.scheduledMaintenance.tryClaim('claim-b', 11, 0)).toBe(false);
  await repo.scheduledMaintenance.renew('claim-a', 12);
  expect(await repo.scheduledMaintenance.tryClaim('claim-b', 13, 12)).toBe(false);
  expect(await repo.scheduledMaintenance.tryClaim('claim-b', 14, 13)).toBe(true);
  await repo.scheduledMaintenance.release('claim-a');
  expect(await repo.scheduledMaintenance.tryClaim('claim-c', 15, 0)).toBe(false);
  await repo.scheduledMaintenance.release('claim-b');
  expect(await repo.scheduledMaintenance.tryClaim('claim-c', 16, 0)).toBe(true);
});
