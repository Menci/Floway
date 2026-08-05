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

const PRIMARY_TOKEN = 'a'.repeat(43);
const SECONDARY_TOKEN = 'b'.repeat(43);
const EXPIRED_OWN_TOKEN = 'c'.repeat(43);
const LIVE_OWN_TOKEN = 'd'.repeat(43);
const EXPIRED_FOREIGN_TOKEN = 'e'.repeat(43);
const FRESH_TOKEN = 'f'.repeat(43);
const NEWEST_FOREIGN_TOKEN = 'g'.repeat(43);

const insert = (repo: Repo, over: Partial<Parameters<Repo['agentSetup']['insertForUser']>[0]> = {}) =>
  repo.agentSetup.insertForUser({
    userId: 7,
    token: PRIMARY_TOKEN,
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
      token: PRIMARY_TOKEN,
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
    expect(await repo.agentSetup.findByToken(PRIMARY_TOKEN)).toEqual(created);
    expect(await repo.agentSetup.findByToken('nope')).toBeNull();
  });

  test('a token collision throws AgentSetupTokenCollisionError without replacing the existing lease', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    // The SQL backend rejects; the in-memory backend throws synchronously. An
    // async wrapper normalizes both into a rejected promise for the assertion.
    await expect((async () => await insert(repo, { userId: 8 }))()).rejects.toBeInstanceOf(AgentSetupTokenCollisionError);
    expect(await repo.agentSetup.findByToken(PRIMARY_TOKEN)).toEqual(created);
  });

  test('multiple unexpired leases per user coexist; insert never sweeps a live sibling', async () => {
    const repo = await makeRepo();
    await insert(repo, { token: PRIMARY_TOKEN, now: 1_000, expiresAt: 5_000 });
    await insert(repo, { token: SECONDARY_TOKEN, now: 2_000, expiresAt: 5_000 });
    expect((await repo.agentSetup.findByToken(PRIMARY_TOKEN))?.token).toBe(PRIMARY_TOKEN);
    expect((await repo.agentSetup.findByToken(SECONDARY_TOKEN))?.token).toBe(SECONDARY_TOKEN);
  });

  test('insert sweeps same-user expiry at the created_at boundary and preserves every other row', async () => {
    const repo = await makeRepo();
    await insert(repo, { token: EXPIRED_OWN_TOKEN, userId: 7, now: 500, expiresAt: 1_000 });
    await insert(repo, { token: LIVE_OWN_TOKEN, userId: 7, now: 500, expiresAt: 1_001 });
    await insert(repo, { token: EXPIRED_FOREIGN_TOKEN, userId: 8, now: 500, expiresAt: 1_000 });
    await insert(repo, { token: FRESH_TOKEN, userId: 7, now: 1_000, expiresAt: 5_000 });
    expect(await repo.agentSetup.findByToken(EXPIRED_OWN_TOKEN)).toBeNull();
    expect((await repo.agentSetup.findByToken(LIVE_OWN_TOKEN))?.token).toBe(LIVE_OWN_TOKEN);
    expect((await repo.agentSetup.findByToken(EXPIRED_FOREIGN_TOKEN))?.token).toBe(EXPIRED_FOREIGN_TOKEN);
    expect((await repo.agentSetup.findByToken(FRESH_TOKEN))?.token).toBe(FRESH_TOKEN);
  });

  test('latestByUserId is deterministic: updated_at, then created_at, then token, all descending', async () => {
    const repo = await makeRepo();
    // Two rows with identical timestamps: the higher token wins.
    await insert(repo, { token: PRIMARY_TOKEN, now: 1_000, expiresAt: 9_000 });
    await insert(repo, { token: SECONDARY_TOKEN, now: 1_000, expiresAt: 9_000 });
    expect((await repo.agentSetup.latestByUserId(7))?.token).toBe(SECONDARY_TOKEN);

    // A configuration write bumps updated_at, so that row becomes latest.
    await repo.agentSetup.updateConfiguration({
      userId: 7, token: PRIMARY_TOKEN, expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a","edited":true}', now: 2_000, expiresAt: 9_000,
    });
    expect((await repo.agentSetup.latestByUserId(7))?.token).toBe(PRIMARY_TOKEN);

    await insert(repo, { token: NEWEST_FOREIGN_TOKEN, userId: 8, now: 3_000, expiresAt: 9_000 });
    expect((await repo.agentSetup.latestByUserId(7))?.token).toBe(PRIMARY_TOKEN);
    expect((await repo.agentSetup.latestByUserId(8))?.token).toBe(NEWEST_FOREIGN_TOKEN);
    expect(await repo.agentSetup.latestByUserId(999)).toBeNull();
  });

  test('updateConfiguration applies the change, bumps the revision, and never rotates the token', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    const configurationJson = '{"apiKeyId":"key-a","claudeCode":{"enabled":true}}';
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7, token: PRIMARY_TOKEN, expectedRevision: 1,
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

  test('updateConfiguration cannot shorten an expiry extended after the request was computed', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    const renewed = await repo.agentSetup.renewLease({ userId: 7, token: PRIMARY_TOKEN, expiresAt: 2_000 });
    expect(renewed.status).toBe('ok');

    const configurationJson = '{"apiKeyId":"key-after-heartbeat"}';
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7,
      token: PRIMARY_TOKEN,
      expectedRevision: 1,
      configurationJson,
      now: 1_100,
      expiresAt: 1_500,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.record).toEqual({
      ...created,
      configurationJson,
      configurationRevision: 2,
      expiresAt: 2_000,
      updatedAt: 1_100,
    });
  });

  test('updateConfiguration reports revision-conflict without mutating when the revision is stale', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    const stale = await repo.agentSetup.updateConfiguration({
      userId: 7, token: PRIMARY_TOKEN, expectedRevision: 0,
      configurationJson: '{"apiKeyId":"key-a"}', now: 1_010, expiresAt: 1_310,
    });
    expect(stale.status).toBe('revision-conflict');
    if (stale.status !== 'revision-conflict') throw new Error('unreachable');
    expect(stale.record).toEqual(created);
    expect(await repo.agentSetup.findByToken(PRIMARY_TOKEN)).toEqual(created);
  });

  test('two concurrent updates from one revision commit exactly one configuration', async () => {
    const repo = await makeRepo();
    await insert(repo);
    const [left, right] = await Promise.all([
      repo.agentSetup.updateConfiguration({
        userId: 7, token: PRIMARY_TOKEN, expectedRevision: 1,
        configurationJson: '{"apiKeyId":"key-left"}', now: 1_010, expiresAt: 1_310,
      }),
      repo.agentSetup.updateConfiguration({
        userId: 7, token: PRIMARY_TOKEN, expectedRevision: 1,
        configurationJson: '{"apiKeyId":"key-right"}', now: 1_011, expiresAt: 1_311,
      }),
    ]);
    expect([left.status, right.status].toSorted()).toEqual(['ok', 'revision-conflict']);
    const winner = left.status === 'ok' ? left.record : right.status === 'ok' ? right.record : null;
    const conflict = left.status === 'revision-conflict' ? left.record : right.status === 'revision-conflict' ? right.record : null;
    if (winner === null || conflict === null) throw new Error('concurrent update outcomes were not ok + revision-conflict');
    expect(winner.configurationRevision).toBe(2);
    expect(conflict).toEqual(winner);
    expect(await repo.agentSetup.findByToken(PRIMARY_TOKEN)).toEqual(winner);
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
      userId: 8, token: PRIMARY_TOKEN, expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a"}', now: 1_010, expiresAt: 1_310,
    });
    expect(foreign.status).toBe('missing');
    // The live lease is untouched by either rejection.
    expect((await repo.agentSetup.findByToken(PRIMARY_TOKEN))?.configurationRevision).toBe(1);
  });

  test('updateConfiguration writes an already-expired but present lease', async () => {
    const repo = await makeRepo();
    await insert(repo, { expiresAt: 1_300 });
    const result = await repo.agentSetup.updateConfiguration({
      userId: 7, token: PRIMARY_TOKEN, expectedRevision: 1,
      configurationJson: '{"apiKeyId":"key-a"}', now: 1_500, expiresAt: 1_800,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.record.token).toBe(PRIMARY_TOKEN);
    expect(result.record.expiresAt).toBe(1_800);
    expect(result.record.configurationRevision).toBe(2);
  });

  test('renewLease extends expiry monotonically without touching the token, revision, or updated_at', async () => {
    const repo = await makeRepo();
    const created = await insert(repo);
    const renewed = await repo.agentSetup.renewLease({ userId: 7, token: PRIMARY_TOKEN, expiresAt: 1_400 });
    expect(renewed.status).toBe('ok');
    if (renewed.status !== 'ok') throw new Error('unreachable');
    expect(renewed.record).toEqual({ ...created, expiresAt: 1_400 });

    const delayed = await repo.agentSetup.renewLease({ userId: 7, token: PRIMARY_TOKEN, expiresAt: 1_350 });
    expect(delayed.status).toBe('ok');
    if (delayed.status !== 'ok') throw new Error('unreachable');
    expect(delayed.record).toEqual(renewed.record);
    expect(await repo.agentSetup.findByToken(PRIMARY_TOKEN)).toEqual(renewed.record);
  });

  test('renewLease revives an expired-but-present lease', async () => {
    const repo = await makeRepo();
    await insert(repo, { expiresAt: 1_300 });
    const renewed = await repo.agentSetup.renewLease({ userId: 7, token: PRIMARY_TOKEN, expiresAt: 5_000 });
    expect(renewed.status).toBe('ok');
    if (renewed.status !== 'ok') throw new Error('unreachable');
    expect(renewed.record.expiresAt).toBe(5_000);
    expect(renewed.record.configurationRevision).toBe(1);
  });

  test('renewLease reports missing when the token does not exist or belongs to another user', async () => {
    const repo = await makeRepo();
    await insert(repo);
    expect((await repo.agentSetup.renewLease({ userId: 7, token: 'nope', expiresAt: 1_400 })).status).toBe('missing');
    expect((await repo.agentSetup.renewLease({ userId: 8, token: PRIMARY_TOKEN, expiresAt: 1_400 })).status).toBe('missing');
    expect((await repo.agentSetup.findByToken(PRIMARY_TOKEN))?.expiresAt).toBe(1_300);
  });
});

test('SQL AgentSetupRepository rejects every corrupt persisted scalar', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const columns = [
    'token', 'user_id', 'configuration_json', 'configuration_revision', 'expires_at', 'created_at', 'updated_at',
  ] as const;
  const validSql: Record<typeof columns[number], string> = {
    token: `'${PRIMARY_TOKEN}'`,
    user_id: '7',
    configuration_json: `'${JSON.stringify({ apiKeyId: 'key-a' })}'`,
    configuration_revision: '1',
    expires_at: '1300',
    created_at: '1000',
    updated_at: '1000',
  };
  const corruptions = [
    { column: 'token', value: "'short'", readLatest: true },
    { column: 'token', value: `'${'!'.repeat(43)}'`, readLatest: true },
    { column: 'user_id', value: "'seven'", readLatest: false },
    { column: 'configuration_json', value: "''", readLatest: false },
    { column: 'configuration_revision', value: '0', readLatest: false },
    { column: 'expires_at', value: "'not-a-number'", readLatest: false },
    { column: 'created_at', value: '-1', readLatest: false },
    { column: 'updated_at', value: '1.5', readLatest: false },
  ] as const;

  for (const { column, value, readLatest } of corruptions) {
    await db.exec('DELETE FROM agent_setup');
    const rowSql = { ...validSql, [column]: value };
    await db.exec(`INSERT INTO agent_setup (${columns.join(', ')}) VALUES (${columns.map(name => rowSql[name]).join(', ')})`);
    const read = readLatest ? repo.agentSetup.latestByUserId(7) : repo.agentSetup.findByToken(PRIMARY_TOKEN);
    await expect(read).rejects.toThrow(`agent_setup.${column}`);
  }
});
