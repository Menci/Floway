import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

describe.each(backends)('SessionsRepo (%s)', (_label, makeRepo) => {

  test('getByIdAndTouch returns the session and bumps last_seen_at', async () => {
    const repo = await makeRepo();
    const session = await repo.sessions.create(1);
    await new Promise(resolve => setTimeout(resolve, 5));
    const touched = await repo.sessions.getByIdAndTouch(session.id);
    expect(touched).not.toBeNull();
    expect(touched!.id).toBe(session.id);
    expect(touched!.lastSeenAt > session.lastSeenAt).toBe(true);
  });

});
