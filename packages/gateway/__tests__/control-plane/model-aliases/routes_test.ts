import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { ModelAlias } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

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

const createAlias = async (adminSession: string, overrides: Record<string, unknown> = {}): Promise<ModelAlias> => {
  const resp = await requestApp('/api/aliases', authed(adminSession, baseBody(overrides)));
  assertEquals(resp.status, 201);
  return (await resp.json()) as ModelAlias;
};

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

test('PUT /api/aliases/:id rename collision returns 409', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  const fast = await createAlias(adminSession, { name: 'gpt-fast' });
  await createAlias(adminSession, { name: 'gpt-slow' });

  const resp = await requestApp(
    `/api/aliases/${fast.id}`,
    putAuthed(adminSession, baseBody({ name: 'gpt-slow' })),
  );
  assertEquals(resp.status, 409);
});

// A model id routinely carries a slash (`vendor/model`). Addressing the row by
// its opaque id keeps every mutation reachable no matter what the operator
// names the alias.
test('an alias whose name contains a slash stays editable and deletable', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  const created = await createAlias(adminSession, { name: 'vendor/model' });

  const updated = await requestApp(
    `/api/aliases/${created.id}`,
    putAuthed(adminSession, baseBody({ name: 'vendor/model', display_name: 'Vendor Model' })),
  );
  assertEquals(updated.status, 200);
  assertEquals(((await updated.json()) as ModelAlias).display_name, 'Vendor Model');

  const deleted = await requestApp(`/api/aliases/${created.id}`, deleteAuthed(adminSession));
  assertEquals(deleted.status, 204);
  assertEquals(await repo.modelAliases.getByName('vendor/model'), null);
});

test('POST /api/aliases rejects reasoning that combines adaptive=true with budget_tokens (400)', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.modelAliases.deleteAll();

  const resp = await requestApp(
    '/api/aliases',
    authed(adminSession, baseBody({
      targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { adaptive: true, budget_tokens: 4096 } } }],
    })),
  );
  assertEquals(resp.status, 400);
});
