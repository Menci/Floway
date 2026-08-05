import { describe, expect, test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb, createSqlJsDatabase, migrationSqlByFilename } from './test-sqlite.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { Repo } from '../../src/repo/types.ts';
import { AgentSetupTokenCollisionError } from '@floway-dev/agent-setup';

type RepoFactory = () => Promise<Repo>;

const makeMemoryRepo: RepoFactory = () => Promise.resolve(new InMemoryRepo());
const makeSqlRepo: RepoFactory = async () => new SqlRepo(await createSqliteTestDb());

const backends: ReadonlyArray<readonly [string, RepoFactory]> = [
  ['memory', makeMemoryRepo],
  ['sql', makeSqlRepo],
];

test('migration 0061 adds optional Claude settings without replacing existing choices', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0061_agent_setup_claude_settings.sql') break;
      db.run(sql);
    }
    const baseConfiguration = {
      apiKeyId: 'key-a',
      claudeCode: {
        model: 'claude-custom',
        defaultOpusModel: 'claude-opus-custom',
        defaultSonnetModel: 'claude-sonnet-custom',
        defaultHaikuModel: 'claude-haiku-custom',
        effortLevel: 'xhigh',
        modelDiscovery: false,
      },
      codex: { model: 'gpt-custom', reasoningEffort: 'vendor-tier' },
    };
    db.run(
      `INSERT INTO agent_setup
        (token, user_id, configuration_json, configuration_revision, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, 2000, 1000, 1000), (?, ?, ?, 1, 2000, 1000, 1000), (?, ?, ?, 1, 2000, 1000, 1000)`,
      [
        'legacy', 1, JSON.stringify(baseConfiguration),
        'selected', 1, JSON.stringify({
          ...baseConfiguration,
          claudeCode: { ...baseConfiguration.claudeCode, cleanupPeriodDays: 365 },
        }),
        'opted-out', 1, JSON.stringify({
          ...baseConfiguration,
          claudeCode: { ...baseConfiguration.claudeCode, optOutAiAttribution: true },
        }),
      ],
    );

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0061_agent_setup_claude_settings.sql');
    if (migration === undefined) throw new Error('missing migration 0061_agent_setup_claude_settings.sql');
    db.run(migration[1]);

    const rows = db.exec('SELECT token, configuration_json FROM agent_setup ORDER BY token')[0];
    if (rows === undefined) throw new Error('migration 0061 returned no agent_setup rows');
    const configurations = Object.fromEntries(rows.values.map(([token, json]) => [
      token as string,
      JSON.parse(json as string) as unknown,
    ]));
    expect(configurations).toEqual({
      legacy: {
        ...baseConfiguration,
        claudeCode: { ...baseConfiguration.claudeCode, cleanupPeriodDays: null, optOutAiAttribution: false },
      },
      'opted-out': {
        ...baseConfiguration,
        claudeCode: { ...baseConfiguration.claudeCode, cleanupPeriodDays: null, optOutAiAttribution: true },
      },
      selected: {
        ...baseConfiguration,
        claudeCode: { ...baseConfiguration.claudeCode, cleanupPeriodDays: 365, optOutAiAttribution: false },
      },
    });
  } finally {
    db.close();
  }
});

test('migration 0068 adds the Claude fable override without replacing existing choices', async () => {
  const db = await createSqlJsDatabase();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0068_agent_setup_fable_model.sql') break;
      db.run(sql);
    }
    const baseConfiguration = {
      apiKeyId: 'key-a',
      claudeCode: {
        model: 'claude-custom',
        defaultOpusModel: 'claude-opus-custom',
        defaultSonnetModel: 'claude-sonnet-custom',
        defaultHaikuModel: 'claude-haiku-custom',
        effortLevel: 'xhigh',
        cleanupPeriodDays: 99999,
        optOutAiAttribution: true,
        modelDiscovery: false,
      },
      codex: { model: 'gpt-custom', reasoningEffort: 'vendor-tier' },
    };
    db.run(
      `INSERT INTO agent_setup
        (token, user_id, configuration_json, configuration_revision, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, 2000, 1000, 1000), (?, ?, ?, 1, 2000, 1000, 1000)`,
      [
        'legacy', 1, JSON.stringify(baseConfiguration),
        'selected', 1, JSON.stringify({
          ...baseConfiguration,
          claudeCode: { ...baseConfiguration.claudeCode, defaultFableModel: 'claude-fable-5[1m]' },
        }),
      ],
    );

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0068_agent_setup_fable_model.sql');
    if (migration === undefined) throw new Error('missing migration 0068_agent_setup_fable_model.sql');
    db.run(migration[1]);

    const rows = db.exec('SELECT token, configuration_json FROM agent_setup ORDER BY token')[0];
    if (rows === undefined) throw new Error('migration 0068 returned no agent_setup rows');
    const configurations = Object.fromEntries(rows.values.map(([token, json]) => [
      token as string,
      JSON.parse(json as string) as unknown,
    ]));
    expect(configurations).toEqual({
      legacy: {
        ...baseConfiguration,
        claudeCode: { ...baseConfiguration.claudeCode, defaultFableModel: null },
      },
      selected: {
        ...baseConfiguration,
        claudeCode: { ...baseConfiguration.claudeCode, defaultFableModel: 'claude-fable-5[1m]' },
      },
    });
  } finally {
    db.close();
  }
});

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

  test('a token collision throws AgentSetupTokenCollisionError without replacing the existing lease', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    // The SQL backend rejects; the in-memory backend throws synchronously. An
    // async wrapper normalizes both into a rejected promise for the assertion.
    await expect((async () => await insert(repo, { userId: 8 }))()).rejects.toBeInstanceOf(AgentSetupTokenCollisionError);
    expect(await repo.agentSetup.findByToken('token-a')).toEqual(created);
  });

  test('multiple unexpired leases per user coexist; insert never sweeps a live sibling', async () => {
    const repo = await makeRepo();
    await insert(repo, { token: 'token-a', now: 1_000, expiresAt: 5_000 });
    await insert(repo, { token: 'token-b', now: 2_000, expiresAt: 5_000 });
    expect((await repo.agentSetup.findByToken('token-a'))?.token).toBe('token-a');
    expect((await repo.agentSetup.findByToken('token-b'))?.token).toBe('token-b');
  });

  test('insert sweeps same-user expiry at the created_at boundary and preserves every other row', async () => {
    const repo = await makeRepo();
    await insert(repo, { token: 'expired-mine', userId: 7, now: 500, expiresAt: 1_000 });
    await insert(repo, { token: 'live-mine', userId: 7, now: 500, expiresAt: 1_001 });
    await insert(repo, { token: 'expired-other', userId: 8, now: 500, expiresAt: 1_000 });
    await insert(repo, { token: 'fresh', userId: 7, now: 1_000, expiresAt: 5_000 });
    expect(await repo.agentSetup.findByToken('expired-mine')).toBeNull();
    expect((await repo.agentSetup.findByToken('live-mine'))?.token).toBe('live-mine');
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

    await insert(repo, { token: 'foreign-newest', userId: 8, now: 3_000, expiresAt: 9_000 });
    expect((await repo.agentSetup.latestByUserId(7))?.token).toBe('token-a');
    expect((await repo.agentSetup.latestByUserId(8))?.token).toBe('foreign-newest');
    expect(await repo.agentSetup.latestByUserId(999)).toBeNull();
  });

  test('updateConfiguration applies the change, bumps the revision, and never rotates the token', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    const configurationJson = '{"apiKeyId":"key-a","claudeCode":{"enabled":true}}';
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7, token: 'token-a', expectedRevision: 1,
      configurationJson, now: 1_010, expiresAt: 1_310,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.record).toEqual({
      ...created,
      configurationJson,
      configurationRevision: 2,
      expiresAt: 1_310,
      updatedAt: 1_010,
    });
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
    expect(await repo.agentSetup.findByToken('token-a')).toEqual(created);
  });

  test('two concurrent updates from one revision commit exactly one configuration', async () => {
    const repo = await makeRepo();
    await insert(repo);
    const [left, right] = await Promise.all([
      repo.agentSetup.updateConfiguration({
        userId: 7, token: 'token-a', expectedRevision: 1,
        configurationJson: '{"apiKeyId":"key-left"}', now: 1_010, expiresAt: 1_310,
      }),
      repo.agentSetup.updateConfiguration({
        userId: 7, token: 'token-a', expectedRevision: 1,
        configurationJson: '{"apiKeyId":"key-right"}', now: 1_011, expiresAt: 1_311,
      }),
    ]);
    expect([left.status, right.status].toSorted()).toEqual(['ok', 'revision-conflict']);
    const winner = left.status === 'ok' ? left.record : right.status === 'ok' ? right.record : null;
    const conflict = left.status === 'revision-conflict' ? left.record : right.status === 'revision-conflict' ? right.record : null;
    if (winner === null || conflict === null) throw new Error('concurrent update outcomes were not ok + revision-conflict');
    expect(winner.configurationRevision).toBe(2);
    expect(conflict).toEqual(winner);
    expect(await repo.agentSetup.findByToken('token-a')).toEqual(winner);
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
    const created = await insert(repo);
    const renewed = await repo.agentSetup.renewLease({ userId: 7, token: 'token-a', expiresAt: 1_400 });
    expect(renewed.status).toBe('ok');
    if (renewed.status !== 'ok') throw new Error('unreachable');
    expect(renewed.record).toEqual({ ...created, expiresAt: 1_400 });
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
});

test('SQL AgentSetupRepository rejects every corrupt persisted scalar', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const columns = [
    'token', 'user_id', 'configuration_json', 'configuration_revision', 'expires_at', 'created_at', 'updated_at',
  ] as const;
  const validSql: Record<typeof columns[number], string> = {
    token: "'token-a'",
    user_id: '7',
    configuration_json: `'${JSON.stringify({ apiKeyId: 'key-a' })}'`,
    configuration_revision: '1',
    expires_at: '1300',
    created_at: '1000',
    updated_at: '1000',
  };
  const corruptions = [
    { column: 'token', value: "''", lookupToken: '' },
    { column: 'user_id', value: "'seven'", lookupToken: 'token-a' },
    { column: 'configuration_json', value: "''", lookupToken: 'token-a' },
    { column: 'configuration_revision', value: '0', lookupToken: 'token-a' },
    { column: 'expires_at', value: "'not-a-number'", lookupToken: 'token-a' },
    { column: 'created_at', value: '-1', lookupToken: 'token-a' },
    { column: 'updated_at', value: '1.5', lookupToken: 'token-a' },
  ] as const;

  for (const { column, value, lookupToken } of corruptions) {
    await db.exec('DELETE FROM agent_setup');
    const rowSql = { ...validSql, [column]: value };
    await db.exec(`INSERT INTO agent_setup (${columns.join(', ')}) VALUES (${columns.map(name => rowSql[name]).join(', ')})`);
    await expect(repo.agentSetup.findByToken(lookupToken)).rejects.toThrow(`agent_setup.${column}`);
  }
});
