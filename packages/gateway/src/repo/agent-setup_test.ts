import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { Repo } from './types.ts';

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

const seed = (repo: Repo) =>
  repo.agentSetup.replaceForUser({
    userId: 7,
    token: 'token-a',
    apiKeyId: 'key-a',
    configurationJson: '{"apiKeyId":"key-a"}',
    now: 1_000,
    expiresAt: 1_300,
  });

describe.each(backends)('AgentSetupRepo (%s)', (_label, makeRepo) => {
  test('replaceForUser creates a fresh lease at revision 1', async () => {
    const repo = await makeRepo();
    const created = await seed(repo);
    expect(created).toEqual({
      userId: 7,
      token: 'token-a',
      apiKeyId: 'key-a',
      configurationJson: '{"apiKeyId":"key-a"}',
      configurationRevision: 1,
      expiresAt: 1_300,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  test('getByUserId and findByToken load the same row', async () => {
    const repo = await makeRepo();
    const created = await seed(repo);
    expect(await repo.agentSetup.getByUserId(7)).toEqual(created);
    expect(await repo.agentSetup.findByToken('token-a')).toEqual(created);
    expect(await repo.agentSetup.getByUserId(999)).toBeNull();
    expect(await repo.agentSetup.findByToken('nope')).toBeNull();
  });

  test('replaceForUser on an existing user increments the revision and preserves createdAt', async () => {
    const repo = await makeRepo();
    await seed(repo);
    const replaced = await repo.agentSetup.replaceForUser({
      userId: 7,
      token: 'token-b',
      apiKeyId: 'key-b',
      configurationJson: '{"apiKeyId":"key-b"}',
      now: 2_000,
      expiresAt: 2_300,
    });
    expect(replaced.configurationRevision).toBe(2);
    expect(replaced.token).toBe('token-b');
    expect(replaced.createdAt).toBe(1_000);
    expect(replaced.updatedAt).toBe(2_000);
    // The old token no longer resolves to any lease.
    expect(await repo.agentSetup.findByToken('token-a')).toBeNull();
  });

  test('updateConfiguration applies the change and increments the revision when token and revision match', async () => {
    const repo = await makeRepo();
    await seed(repo);
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7,
      token: 'token-a',
      expectedRevision: 1,
      apiKeyId: 'key-a',
      configurationJson: '{"apiKeyId":"key-a","claudeCode":{"enabled":true}}',
      now: 1_010,
      replacementToken: 'token-b',
      replacementExpiresAt: 1_310,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.record.configurationRevision).toBe(2);
    expect(result.record.configurationJson).toBe('{"apiKeyId":"key-a","claudeCode":{"enabled":true}}');
    // Live lease: expiry is extended but the token is NOT rotated.
    expect(result.record.token).toBe('token-a');
    expect(result.record.expiresAt).toBe(1_310);
  });

  test('updateConfiguration reports revision-conflict without mutating when the revision is stale', async () => {
    const repo = await makeRepo();
    const created = await seed(repo);
    const stale = await repo.agentSetup.updateConfiguration({
      userId: 7,
      token: 'token-a',
      expectedRevision: 0,
      apiKeyId: 'key-a',
      configurationJson: '{"apiKeyId":"key-a"}',
      now: 1_010,
      replacementToken: 'token-b',
      replacementExpiresAt: 1_310,
    });
    expect(stale.status).toBe('revision-conflict');
    if (stale.status !== 'revision-conflict') throw new Error('unreachable');
    expect(stale.record).toEqual(created);
  });

  test('updateConfiguration reports superseded when the token no longer matches', async () => {
    const repo = await makeRepo();
    await seed(repo);
    const superseded = await repo.agentSetup.updateConfiguration({
      userId: 7,
      token: 'other-token',
      expectedRevision: 1,
      apiKeyId: 'key-a',
      configurationJson: '{"apiKeyId":"key-a"}',
      now: 1_010,
      replacementToken: 'token-b',
      replacementExpiresAt: 1_310,
    });
    expect(superseded.status).toBe('superseded');
    // The live lease is untouched.
    expect((await repo.agentSetup.getByUserId(7))?.configurationRevision).toBe(1);
  });

  test('updateConfiguration rotates the token when the lease has already expired', async () => {
    const repo = await makeRepo();
    await seed(repo);
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7,
      token: 'token-a',
      expectedRevision: 1,
      apiKeyId: 'key-a',
      configurationJson: '{"apiKeyId":"key-a"}',
      now: 1_500,
      replacementToken: 'token-b',
      replacementExpiresAt: 1_800,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.record.token).toBe('token-b');
    expect(result.record.expiresAt).toBe(1_800);
    expect(result.record.configurationRevision).toBe(2);
    expect(await repo.agentSetup.findByToken('token-a')).toBeNull();
    expect((await repo.agentSetup.findByToken('token-b'))?.userId).toBe(7);
  });

  test('updateConfiguration lets a stale revision win over expiry: no rotation, then the retry rotates', async () => {
    const repo = await makeRepo();
    const created = await seed(repo);

    // The lease is already expired (seed expiry 1_300, now 1_500) AND edited
    // against a stale revision. The revision conflict wins over the rotation the
    // expiry would otherwise trigger: the row is untouched and its token stays.
    const conflict = await repo.agentSetup.updateConfiguration({
      userId: 7,
      token: 'token-a',
      expectedRevision: 0,
      apiKeyId: 'key-a',
      configurationJson: '{"apiKeyId":"key-a","codex":{"enabled":false}}',
      now: 1_500,
      replacementToken: 'token-b',
      replacementExpiresAt: 1_800,
    });
    expect(conflict.status).toBe('revision-conflict');
    if (conflict.status !== 'revision-conflict') throw new Error('unreachable');
    expect(conflict.record).toEqual(created);
    // No rotation happened: the replacement token never became live.
    expect(await repo.agentSetup.findByToken('token-b')).toBeNull();
    expect((await repo.agentSetup.findByToken('token-a'))?.configurationRevision).toBe(1);

    // Rebasing onto the live revision and retrying — still against the expired
    // lease — is the write that finally rotates the token.
    const retry = await repo.agentSetup.updateConfiguration({
      userId: 7,
      token: 'token-a',
      expectedRevision: conflict.record.configurationRevision,
      apiKeyId: 'key-a',
      configurationJson: '{"apiKeyId":"key-a","codex":{"enabled":false}}',
      now: 1_500,
      replacementToken: 'token-c',
      replacementExpiresAt: 1_900,
    });
    expect(retry.status).toBe('ok');
    if (retry.status !== 'ok') throw new Error('unreachable');
    expect(retry.record.token).toBe('token-c');
    expect(retry.record.configurationRevision).toBe(2);
    expect(retry.record.expiresAt).toBe(1_900);
    expect(await repo.agentSetup.findByToken('token-a')).toBeNull();
    expect((await repo.agentSetup.findByToken('token-c'))?.userId).toBe(7);
  });

  test('renewLease extends a live lease without rotating the token or touching the revision', async () => {
    const repo = await makeRepo();
    await seed(repo);
    const renewed = await repo.agentSetup.renewLease({
      userId: 7,
      token: 'token-a',
      now: 1_100,
      expiresAt: 1_400,
      replacementToken: 'token-b',
    });
    expect(renewed.status).toBe('ok');
    if (renewed.status !== 'ok') throw new Error('unreachable');
    expect(renewed.record.token).toBe('token-a');
    expect(renewed.record.expiresAt).toBe(1_400);
    expect(renewed.record.configurationRevision).toBe(1);
    expect(renewed.record.configurationJson).toBe('{"apiKeyId":"key-a"}');
  });

  test('renewLease rotates an expired matching token while preserving the configuration and revision', async () => {
    const repo = await makeRepo();
    await seed(repo);
    const renewed = await repo.agentSetup.renewLease({
      userId: 7,
      token: 'token-a',
      now: 1_500,
      expiresAt: 1_800,
      replacementToken: 'token-b',
    });
    expect(renewed.status).toBe('ok');
    if (renewed.status !== 'ok') throw new Error('unreachable');
    expect(renewed.record.token).toBe('token-b');
    expect(renewed.record.expiresAt).toBe(1_800);
    // Rotation is not a configuration change: revision and config are preserved.
    expect(renewed.record.configurationRevision).toBe(1);
    expect(renewed.record.configurationJson).toBe('{"apiKeyId":"key-a"}');
    expect(await repo.agentSetup.findByToken('token-a')).toBeNull();
  });

  test('renewLease reports superseded when the token no longer matches', async () => {
    const repo = await makeRepo();
    await seed(repo);
    const superseded = await repo.agentSetup.renewLease({
      userId: 7,
      token: 'other-token',
      now: 1_100,
      expiresAt: 1_400,
      replacementToken: 'token-b',
    });
    expect(superseded.status).toBe('superseded');
    expect((await repo.agentSetup.getByUserId(7))?.token).toBe('token-a');
  });

  test('an expired lease preserves its configuration until it is renewed', async () => {
    const repo = await makeRepo();
    await seed(repo);
    // Far past expiry, the row and its configuration remain readable.
    const stored = await repo.agentSetup.getByUserId(7);
    expect(stored?.configurationJson).toBe('{"apiKeyId":"key-a"}');
    expect(stored?.expiresAt).toBe(1_300);
  });

  test('deleteAll removes every lease', async () => {
    const repo = await makeRepo();
    await seed(repo);
    await repo.agentSetup.deleteAll();
    expect(await repo.agentSetup.getByUserId(7)).toBeNull();
  });
});
