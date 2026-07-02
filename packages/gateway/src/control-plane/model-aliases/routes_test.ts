import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import type { ModelAlias } from '@floway-dev/protocols/common';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const authed = (adminSession: string, body?: unknown, method?: string): RequestInit => ({
  method: method ?? (body === undefined ? 'GET' : 'POST'),
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const putAuthed = (adminSession: string, body: unknown): RequestInit => authed(adminSession, body, 'PUT');
const deleteAuthed = (adminSession: string): RequestInit => ({
  method: 'DELETE',
  headers: { 'x-floway-session': adminSession },
});

const baseBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'gpt-fast',
  kind: 'chat',
  selection: 'first-available',
  display_name: null,
  visible_in_models_list: true,
  targets: [
    { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } },
  ],
  announced_metadata: null,
  ...overrides,
});

test('GET /api/aliases lists every row in sort order', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await repo.modelAliases.insert({
    name: 'b', kind: 'chat', selection: 'random', displayName: null, visibleInModelsList: true,
    targets: [{ target_model_id: 'm1', rules: {} }],
    announcedMetadata: null,
    sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await repo.modelAliases.insert({
    name: 'a', kind: 'chat', selection: 'random', displayName: null, visibleInModelsList: true,
    targets: [{ target_model_id: 'm2', rules: {} }],
    announcedMetadata: null,
    sortOrder: 0, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  });

  const resp = await requestApp('/api/aliases', authed(adminSession));
  assertEquals(resp.status, 200);
  const list = (await resp.json()) as ModelAlias[];
  assertEquals(list.map(r => r.name), ['a', 'b']);
});

test('POST /api/aliases creates an alias and returns the snake_case wire shape', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp('/api/aliases', authed(adminSession, baseBody()));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as ModelAlias;
  assertEquals(created.name, 'gpt-fast');
  assertEquals(created.visible_in_models_list, true);
  assertEquals(created.targets[0].target_model_id, 'gpt-5.4');

  const stored = await repo.modelAliases.getByName('gpt-fast');
  assertExists(stored);
  assertEquals(stored.visibleInModelsList, true);
});

test('POST /api/aliases rejects a name collision with 409', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await requestApp('/api/aliases', authed(adminSession, baseBody()));

  const resp = await requestApp('/api/aliases', authed(adminSession, baseBody()));
  assertEquals(resp.status, 409);
  const body = (await resp.json()) as { error?: string };
  assertEquals(body.error?.includes('already exists'), true);
});

test('PUT /api/aliases/:name updates rules and refreshes updated_at', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await requestApp('/api/aliases', authed(adminSession, baseBody()));
  const before = await repo.modelAliases.getByName('gpt-fast');
  assertExists(before);
  await new Promise(resolve => setTimeout(resolve, 5));

  const resp = await requestApp(
    '/api/aliases/gpt-fast',
    putAuthed(adminSession, baseBody({ display_name: 'GPT Fast', targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'high' } } }] })),
  );
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as ModelAlias;
  assertEquals(updated.display_name, 'GPT Fast');
  assertEquals(updated.targets[0].rules, { reasoning: { effort: 'high' } });
  // createdAt is preserved; updatedAt is fresh.
  assertEquals(updated.created_at, before.createdAt);
  if (updated.updated_at === before.updatedAt) throw new Error('updated_at did not refresh');
});

test('PUT /api/aliases/:name with a different body.name renames the row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await requestApp('/api/aliases', authed(adminSession, baseBody()));

  const resp = await requestApp(
    '/api/aliases/gpt-fast',
    putAuthed(adminSession, baseBody({ name: 'gpt-fastest' })),
  );
  assertEquals(resp.status, 200);
  assertEquals(await repo.modelAliases.getByName('gpt-fast'), null);
  assertExists(await repo.modelAliases.getByName('gpt-fastest'));
});

test('PUT /api/aliases/:name rename collision returns 409', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await requestApp('/api/aliases', authed(adminSession, baseBody({ name: 'gpt-fast' })));
  await requestApp('/api/aliases', authed(adminSession, baseBody({ name: 'gpt-slow' })));

  const resp = await requestApp(
    '/api/aliases/gpt-fast',
    putAuthed(adminSession, baseBody({ name: 'gpt-slow' })),
  );
  assertEquals(resp.status, 409);
});

test('PUT /api/aliases/:name on a missing alias returns 404', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp('/api/aliases/nope', putAuthed(adminSession, baseBody({ name: 'nope' })));
  assertEquals(resp.status, 404);
});

test('DELETE /api/aliases/:name returns 204 when present', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await requestApp('/api/aliases', authed(adminSession, baseBody()));

  const resp = await requestApp('/api/aliases/gpt-fast', deleteAuthed(adminSession));
  assertEquals(resp.status, 204);
  assertEquals(await repo.modelAliases.getByName('gpt-fast'), null);
});

test('DELETE /api/aliases/:name is idempotent — 204 even when the row is absent', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp('/api/aliases/missing', deleteAuthed(adminSession));
  assertEquals(resp.status, 204);
});

test('POST /api/aliases rejects an empty targets array with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp('/api/aliases', authed(adminSession, baseBody({ targets: [] })));
  assertEquals(resp.status, 400);
});

test('POST /api/aliases rejects an empty target_model_id with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp(
    '/api/aliases',
    authed(adminSession, baseBody({ targets: [{ target_model_id: '', rules: {} }] })),
  );
  assertEquals(resp.status, 400);
});

test('POST /api/aliases rejects non-empty rules on kind=embedding with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp(
    '/api/aliases',
    authed(adminSession, baseBody({
      kind: 'embedding',
      targets: [{ target_model_id: 'text-embedding-3', rules: { verbosity: 'low' } }],
    })),
  );
  assertEquals(resp.status, 400);
});

test('POST /api/aliases accepts kind=embedding with empty rules', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp(
    '/api/aliases',
    authed(adminSession, baseBody({
      kind: 'embedding',
      targets: [{ target_model_id: 'text-embedding-3', rules: {} }],
    })),
  );
  assertEquals(resp.status, 201);
});

test('POST /api/aliases rejects announced_metadata.chat on a non-chat alias with 400', async () => {
  // A `chat` block on an embedding / image alias would land on the row's
  // announced-metadata sidecar and, at listing time, get surfaced onto the
  // /v1/models entry — advertising `chat: {...}` on a row whose `kind` says
  // it has none. The schema keeps the row structurally coherent by rejecting
  // the mismatch at the boundary.
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp(
    '/api/aliases',
    authed(adminSession, baseBody({
      kind: 'embedding',
      targets: [{ target_model_id: 'text-embedding-3', rules: {} }],
      announced_metadata: { chat: { modalities: { input: ['text'], output: ['text'] } } },
    })),
  );
  assertEquals(resp.status, 400);
});

test('POST /api/aliases accepts announced_metadata.limits on a non-chat alias', async () => {
  // limits stays legal on every kind — every model has a context/output
  // token window regardless of endpoint family.
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp(
    '/api/aliases',
    authed(adminSession, baseBody({
      kind: 'embedding',
      targets: [{ target_model_id: 'text-embedding-3', rules: {} }],
      announced_metadata: { limits: { max_context_window_tokens: 8192 } },
    })),
  );
  assertEquals(resp.status, 201);
});

test('POST /api/aliases rejects unknown reasoning fields on a chat target with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp(
    '/api/aliases',
    authed(adminSession, baseBody({
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { bogus: 1 } } }],
    })),
  );
  assertEquals(resp.status, 400);
});
