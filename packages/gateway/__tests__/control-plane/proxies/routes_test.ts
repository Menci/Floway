import { afterEach, beforeEach, test } from 'vitest';

import type { SerializedBackoffRow } from '../../../src/control-plane/proxies/serialize.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { initSocketDial, resetSocketDialForTesting, type SocketDial } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Stub SocketDial so the test endpoint hits a deterministic error path
// (`runProxiedRequest` calls connect() and we surface its rejection as the
// response's `error` field). The proxy library has no other path to a real
// socket, so this fully isolates the handler from the network. Reset the
// singleton in afterEach so a later suite that expects an uninitialized
// SocketDial doesn't see this stub.
const stubFailingSocketDial = (): SocketDial => ({
  connect: async () => {
    throw new Error('stub: dial refused');
  },
  startTls: async () => {
    throw new Error('stub: dial refused');
  },
});

beforeEach(() => {
  initSocketDial(stubFailingSocketDial());
});

afterEach(() => {
  resetSocketDialForTesting();
});

const SOCKS_URL = 'socks5://user:pass@198.51.100.10:1080';
const HTTP_URL = 'http://198.51.100.20:3128';

type AppTestContext = Awaited<ReturnType<typeof setupAppTest>>;

// Backoff rows reference both parents, so each scenario saves the proxies and
// upstreams its rows name before recording dial failures against them.
const seedBackoffParents = async (
  { repo, copilotUpstream }: AppTestContext,
  proxyIds: readonly string[],
  upstreams: ReadonlyArray<{ id: string; name: string; hue: number }>,
): Promise<void> => {
  for (const id of proxyIds) await repo.proxies.insert({ id, name: id, url: HTTP_URL, dialTimeoutSeconds: null });
  for (const upstream of upstreams) await saveUpstreamForTest(repo.upstreams, { ...copilotUpstream, ...upstream });
};

const authed = (adminSession: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const patchAuthed = (adminSession: string, body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  body: JSON.stringify(body),
});

const deleteAuthed = (adminSession: string): RequestInit => ({
  method: 'DELETE',
  headers: { 'x-floway-session': adminSession },
});

test('POST /api/proxies rejects an unparseable URL with 400', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/proxies', authed(adminSession, { name: 'Bad', url: 'gibberish' }));
  assertEquals(resp.status, 400);
});

test('PATCH /api/proxies/:id with a new url clears outstanding backoff rows', async () => {
  const ctx = await setupAppTest();
  const { repo, adminSession } = ctx;
  await seedBackoffParents(ctx, ['p1'], [{ id: 'up_a', name: 'A', hue: 210 }, { id: 'up_b', name: 'B', hue: 120 }]);
  // Two upstreams have already escalated this proxy through several failures.
  // After the URL changes the operator expects an immediate retry; the dial
  // layer must not keep skipping the row up to an hour against stale state.
  for (let n = 0; n < 5; n++) await repo.proxyBackoffs.recordDialFailure('p1', 'up_a', 'boom');
  for (let n = 0; n < 5; n++) await repo.proxyBackoffs.recordDialFailure('p1', 'up_b', 'boom');

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { url: SOCKS_URL }));
  assertEquals(resp.status, 200);

  assertEquals((await repo.proxyBackoffs.listForProxy('p1')).length, 0);
});

test('DELETE /api/proxies/:id returns 409 when an upstream references the proxy', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_ref', name: 'Referenced', url: HTTP_URL, dialTimeoutSeconds: null });
  await saveUpstreamForTest(repo.upstreams, { ...copilotUpstream, proxyFallbackList: [{ id: 'p_ref' }] });

  const resp = await requestApp('/api/proxies/p_ref', deleteAuthed(adminSession));
  assertEquals(resp.status, 409);
  const body = (await resp.json()) as { error?: string; referencing_upstream_ids?: string[] };
  assertEquals(body.referencing_upstream_ids, [copilotUpstream.id]);
  assertExists(await repo.proxies.getById('p_ref'));
});

test('GET /api/proxies/backoffs returns every backoff row regardless of proxy', async () => {
  const ctx = await setupAppTest();
  const { repo, adminSession } = ctx;
  await seedBackoffParents(ctx, ['p_a', 'p_b'], [
    { id: 'up_a', name: 'Primary Copilot', hue: 210 },
    { id: 'up_b', name: 'Backup Copilot', hue: 120 },
  ]);
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_a', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_b', 'kaboom');

  const resp = await requestApp('/api/proxies/backoffs', authed(adminSession));
  assertEquals(resp.status, 200);
  const rows = (await resp.json()) as SerializedBackoffRow[];
  assertEquals(rows.length, 2);
  const pairs = rows.map(r => `${r.proxy_id}/${r.upstream_id}`).sort();
  assertEquals(pairs, ['p_a/up_a', 'p_b/up_b']);
  assertEquals(rows.map(row => row.upstream.name).sort(), ['Backup Copilot', 'Primary Copilot']);
});

test('POST /api/proxies/:id/backoffs/reset with no body clears every row for the proxy', async () => {
  const ctx = await setupAppTest();
  const { repo, adminSession } = ctx;
  await seedBackoffParents(ctx, ['p_a', 'p_b'], [{ id: 'up_x', name: 'X', hue: 210 }, { id: 'up_y', name: 'Y', hue: 120 }]);
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_x', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_y', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_x', 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs/reset', authed(adminSession, {}));
  assertEquals(resp.status, 200);
  assertEquals(await resp.json(), { ok: true });

  assertEquals((await repo.proxyBackoffs.listForProxy('p_a')).length, 0);
  assertEquals((await repo.proxyBackoffs.listForProxy('p_b')).length, 1);
});
