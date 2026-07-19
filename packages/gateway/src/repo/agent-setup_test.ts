import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import type { Repo } from './types.ts';
import { AgentSetupTokenCollisionError } from '@floway-dev/agent-setup';

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

const insert = (repo: Repo, over: Partial<Parameters<Repo['agentSetup']['insertForUser']>[0]> = {}) =>
  repo.agentSetup.insertForUser({
    userId: 7,
    token: 'token-a',
    configurationJson: '{"apiKeyId":"key-a"}',
    now: 1_000,
    expiresAt: 1_300,
    ...over,
  });

describe.each(backends)('AgentSetupRepository (%s)', (_label, makeRepo) => {
  test('insertForUser creates a fresh lease at revision 1', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    expect(created).toEqual({
      userId: 7,
      token: 'token-a',
      configurationJson: '{"apiKeyId":"key-a"}',
      configurationRevision: 1,
      expiresAt: 1_300,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  test('findByToken loads exactly the addressed row', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    expect(await repo.agentSetup.findByToken('token-a')).toEqual(created);
    expect(await repo.agentSetup.findByToken('nope')).toBeNull();
  });

  test('a token collision throws AgentSetupTokenCollisionError', async () => {
    const repo = await makeRepo();
    await insert(repo);
    // The SQL backend rejects; the in-memory backend throws synchronously. An
    // async wrapper normalizes both into a rejected promise for the assertion.
    await expect((async () => await insert(repo, { userId: 8 }))()).rejects.toBeInstanceOf(AgentSetupTokenCollisionError);
  });

  test('multiple unexpired leases per user coexist; insert never sweeps a live sibling', async () => {
    const repo = await makeRepo();
    await insert(repo, { token: 'token-a', now: 1_000, expiresAt: 5_000 });
    await insert(repo, { token: 'token-b', now: 2_000, expiresAt: 5_000 });
    expect((await repo.agentSetup.findByToken('token-a'))?.token).toBe('token-a');
    expect((await repo.agentSetup.findByToken('token-b'))?.token).toBe('token-b');
  });

  test('insert sweeps only the same user\'s expired rows, measured against the new created_at', async () => {
    const repo = await makeRepo();
    await insert(repo, { token: 'expired-mine', userId: 7, now: 500, expiresAt: 900 });
    await insert(repo, { token: 'expired-other', userId: 8, now: 500, expiresAt: 900 });
    await insert(repo, { token: 'fresh', userId: 7, now: 1_000, expiresAt: 5_000 });
    // My expired sibling is swept; a different user's expired row is untouched;
    // the new row survives.
    expect(await repo.agentSetup.findByToken('expired-mine')).toBeNull();
    expect((await repo.agentSetup.findByToken('expired-other'))?.token).toBe('expired-other');
    expect((await repo.agentSetup.findByToken('fresh'))?.token).toBe('fresh');
  });

  test('latestByUserId is deterministic: updated_at, then created_at, then token, all descending', async () => {
    const repo = await makeRepo();
    // Two rows with identical timestamps: the higher token wins.
    await insert(repo, { token: 'token-a', now: 1_000, expiresAt: 9_000 });
    await insert(repo, { token: 'token-b', now: 1_000, expiresAt: 9_000 });
    expect((await repo.agentSetup.latestByUserId(7))?.token).toBe('token-b');

    // A configuration write bumps updated_at, so that row becomes latest.
    await repo.agentSetup.updateConfiguration({
      userId: 7, token: 'token-a', expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a","edited":true}', now: 2_000, expiresAt: 9_000,
    });
    expect((await repo.agentSetup.latestByUserId(7))?.token).toBe('token-a');
    expect(await repo.agentSetup.latestByUserId(999)).toBeNull();
  });

  test('updateConfiguration applies the change, bumps the revision, and never rotates the token', async () => {
    const repo = await makeRepo();
    await insert(repo);
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7, token: 'token-a', expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a","claudeCode":{"enabled":true}}', now: 1_010, expiresAt: 1_310,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.record.configurationRevision).toBe(2);
    expect(result.record.configurationJson).toBe('{"apiKeyId":"key-a","claudeCode":{"enabled":true}}');
    expect(result.record.token).toBe('token-a');
    expect(result.record.expiresAt).toBe(1_310);
    expect(result.record.updatedAt).toBe(1_010);
  });

  test('updateConfiguration reports revision-conflict without mutating when the revision is stale', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    const stale = await repo.agentSetup.updateConfiguration({
      userId: 7, token: 'token-a', expectedRevision: 0,
      configurationJson: '{"apiKeyId":"key-a"}', now: 1_010, expiresAt: 1_310,
    });
    expect(stale.status).toBe('revision-conflict');
    if (stale.status !== 'revision-conflict') throw new Error('unreachable');
    expect(stale.record).toEqual(created);
  });

  test('updateConfiguration reports missing when the token does not exist or belongs to another user', async () => {
    const repo = await makeRepo();
    await insert(repo);
    const absent = await repo.agentSetup.updateConfiguration({
      userId: 7, token: 'other-token', expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a"}', now: 1_010, expiresAt: 1_310,
    });
    expect(absent.status).toBe('missing');
    const foreign = await repo.agentSetup.updateConfiguration({
      userId: 8, token: 'token-a', expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a"}', now: 1_010, expiresAt: 1_310,
    });
    expect(foreign.status).toBe('missing');
    // The live lease is untouched by either rejection.
    expect((await repo.agentSetup.findByToken('token-a'))?.configurationRevision).toBe(1);
  });

  test('updateConfiguration writes an already-expired but present lease', async () => {
    const repo = await makeRepo();
    await insert(repo, { expiresAt: 1_300 });
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7, token: 'token-a', expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a"}', now: 1_500, expiresAt: 1_800,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.record.token).toBe('token-a');
    expect(result.record.expiresAt).toBe(1_800);
    expect(result.record.configurationRevision).toBe(2);
  });

  test('renewLease extends expiry without touching the token, revision, or updated_at', async () => {
    const repo = await makeRepo();
    await insert(repo);
    const renewed = await repo.agentSetup.renewLease({ userId: 7, token: 'token-a', expiresAt: 1_400 });
    expect(renewed.status).toBe('ok');
    if (renewed.status !== 'ok') throw new Error('unreachable');
    expect(renewed.record.token).toBe('token-a');
    expect(renewed.record.expiresAt).toBe(1_400);
    expect(renewed.record.configurationRevision).toBe(1);
    expect(renewed.record.updatedAt).toBe(1_000);
    expect(renewed.record.configurationJson).toBe('{"apiKeyId":"key-a"}');
  });

  test('renewLease revives an expired-but-present lease', async () => {
    const repo = await makeRepo();
    await insert(repo, { expiresAt: 1_300 });
    const renewed = await repo.agentSetup.renewLease({ userId: 7, token: 'token-a', expiresAt: 5_000 });
    expect(renewed.status).toBe('ok');
    if (renewed.status !== 'ok') throw new Error('unreachable');
    expect(renewed.record.expiresAt).toBe(5_000);
    expect(renewed.record.configurationRevision).toBe(1);
  });

  test('renewLease reports missing when the token does not exist or belongs to another user', async () => {
    const repo = await makeRepo();
    await insert(repo);
    expect((await repo.agentSetup.renewLease({ userId: 7, token: 'nope', expiresAt: 1_400 })).status).toBe('missing');
    expect((await repo.agentSetup.renewLease({ userId: 8, token: 'token-a', expiresAt: 1_400 })).status).toBe('missing');
    expect((await repo.agentSetup.findByToken('token-a'))?.expiresAt).toBe(1_300);
  });

  test('an expired lease preserves its configuration until it is renewed', async () => {
    const repo = await makeRepo();
    await insert(repo);
    const stored = await repo.agentSetup.findByToken('token-a');
    expect(stored?.configurationJson).toBe('{"apiKeyId":"key-a"}');
    expect(stored?.expiresAt).toBe(1_300);
  });
});
