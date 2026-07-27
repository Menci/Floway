import { afterEach, beforeEach, test } from 'vitest';

import type { SerializedBackoffRow, SerializedProxyRecord } from '../../../src/control-plane/proxies/serialize.ts';
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
});

beforeEach(() => {
  initSocketDial(stubFailingSocketDial());
});

afterEach(() => {
  resetSocketDialForTesting();
});

const SOCKS_URL = 'socks5://user:pass@198.51.100.10:1080';
const HTTP_URL = 'http://198.51.100.20:3128';

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

test('GET /api/proxies returns rows ordered by createdAt', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_a', name: 'First', url: HTTP_URL, dialTimeoutSeconds: null });
  await new Promise(resolve => setTimeout(resolve, 5));
  await repo.proxies.insert({ id: 'p_b', name: 'Second', url: SOCKS_URL, dialTimeoutSeconds: null });

  const resp = await requestApp('/api/proxies', authed(adminSession));
  assertEquals(resp.status, 200);
  const list = (await resp.json()) as SerializedProxyRecord[];
  assertEquals(list.map(p => p.id), ['p_a', 'p_b']);
  assertEquals(list[0].name, 'First');
  assertEquals(list[0].url, HTTP_URL);
});

test('POST /api/proxies creates a row', async () => {
  const { repo, adminSession } = await setupAppTest();

  const resp = await requestApp('/api/proxies', authed(adminSession, { name: 'New', url: SOCKS_URL }));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as SerializedProxyRecord;
  assertEquals(created.name, 'New');
  assertEquals(created.url, SOCKS_URL);

  const stored = await repo.proxies.getById(created.id);
  assertExists(stored);
  assertEquals(stored.url, SOCKS_URL);
});

test('POST /api/proxies rejects an unparseable URL with 400', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/proxies', authed(adminSession, { name: 'Bad', url: 'gibberish' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error?: string };
  assertEquals(body.error?.startsWith('Invalid proxy URI:'), true);
  // Pin no doubled prefix: parseProxyUri's URL-constructor branch raises
  // 'malformed proxy URI: …'; the wrapper must strip that internal prefix
  // so the operator sees a single 'Invalid proxy URI: …' framing.
  assertEquals(body.error?.includes('proxy URI: malformed proxy URI'), false);
});

test('PATCH /api/proxies/:id partially updates a proxy row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, dialTimeoutSeconds: null });

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { name: 'Renamed' }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedProxyRecord;
  assertEquals(updated.name, 'Renamed');
  assertEquals(updated.url, HTTP_URL);
});

test('PATCH /api/proxies/:id with a new url clears outstanding backoff rows', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, dialTimeoutSeconds: null });
  // Two upstreams have already escalated this proxy through several failures.
  // After the URL changes the operator expects an immediate retry; the dial
  // layer must not keep skipping the row up to an hour against stale state.
  for (let n = 0; n < 5; n++) await repo.proxyBackoffs.recordDialFailure('p1', 'up_a', 'boom');
  for (let n = 0; n < 5; n++) await repo.proxyBackoffs.recordDialFailure('p1', 'up_b', 'boom');

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { url: SOCKS_URL }));
  assertEquals(resp.status, 200);

  assertEquals((await repo.proxyBackoffs.listForProxy('p1')).length, 0);
});

test('PATCH /api/proxies/:id without changing the url leaves backoff rows intact', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p1', 'up_a', 'boom');

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { name: 'Renamed' }));
  assertEquals(resp.status, 200);

  assertEquals((await repo.proxyBackoffs.listForProxy('p1')).length, 1);
});

test('PATCH /api/proxies/:id with dial_timeout_seconds=120 stores the override', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'P', url: HTTP_URL, dialTimeoutSeconds: null });

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { dial_timeout_seconds: 120 }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedProxyRecord;
  assertEquals(updated.dial_timeout_seconds, 120);

  const stored = await repo.proxies.getById('p1');
  assertEquals(stored?.dialTimeoutSeconds, 120);
});

test('PATCH /api/proxies/:id with dial_timeout_seconds absent leaves the existing value', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'P', url: HTTP_URL, dialTimeoutSeconds: 90 });

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { name: 'Renamed' }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedProxyRecord;
  assertEquals(updated.dial_timeout_seconds, 90);

  const stored = await repo.proxies.getById('p1');
  assertEquals(stored?.dialTimeoutSeconds, 90);
});

test('PATCH /api/proxies/:id with dial_timeout_seconds=null clears it back to default', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'P', url: HTTP_URL, dialTimeoutSeconds: 90 });

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { dial_timeout_seconds: null }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as SerializedProxyRecord;
  assertEquals(updated.dial_timeout_seconds, null);

  const stored = await repo.proxies.getById('p1');
  assertEquals(stored?.dialTimeoutSeconds, null);
});

test('DELETE /api/proxies/:id returns 204 when no upstream references the proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_del', name: 'Doomed', url: HTTP_URL, dialTimeoutSeconds: null });

  const resp = await requestApp('/api/proxies/p_del', deleteAuthed(adminSession));
  assertEquals(resp.status, 204);
  assertEquals(await repo.proxies.getById('p_del'), null);
});

test('DELETE /api/proxies/:id returns 409 when an upstream references the proxy', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_ref', name: 'Referenced', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.upstreams.save({ ...copilotUpstream, proxyFallbackList: [{ id: 'p_ref' }] });

  const resp = await requestApp('/api/proxies/p_ref', deleteAuthed(adminSession));
  assertEquals(resp.status, 409);
  const body = (await resp.json()) as { error?: string; referencing_upstream_ids?: string[] };
  assertEquals(body.referencing_upstream_ids, [copilotUpstream.id]);
  assertExists(await repo.proxies.getById('p_ref'));
});

test('POST /api/proxies/test runs against the body URL without touching any row', async () => {
  const { repo, adminSession } = await setupAppTest();

  const resp = await requestApp('/api/proxies/test', authed(adminSession, { url: HTTP_URL }));
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { ok: boolean; error?: string; egress_ip?: string };
  assertEquals(body.ok, false);
  // The HTTP CONNECT runner wraps the underlying SocketDial rejection with
  // "tcp connect to <host>:<port> failed". The exact upstream cause is the
  // stubbed Error but only the wrapping makes it into the message — that's
  // still the actionable surface (operator sees which dial leg failed).
  assertEquals(body.error?.includes('tcp connect to 198.51.100.20:3128 failed'), true);

  // The endpoint is body-driven; no proxies should be created or modified
  // as a side effect, even if the URL happened to round-trip.
  assertEquals((await repo.proxies.list()).length, 0);
});

test('POST /api/proxies/test returns 400 for an unparseable URL', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/proxies/test', authed(adminSession, { url: 'gibberish-no-scheme' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.startsWith('Invalid proxy URI:'), true);
});

test('GET /api/proxies/:id/backoffs returns rows scoped to the proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_a', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_a', 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs', authed(adminSession));
  assertEquals(resp.status, 200);
  const rows = (await resp.json()) as SerializedBackoffRow[];
  assertEquals(rows.length, 1);
  assertEquals(rows[0].proxy_id, 'p_a');
  assertEquals(rows[0].upstream_id, 'up_a');
  assertEquals(rows[0].fail_count, 1);
  assertEquals(rows[0].last_error, 'boom');
});

test('GET /api/proxies/backoffs returns every backoff row regardless of proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_a', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_b', 'kaboom');

  const resp = await requestApp('/api/proxies/backoffs', authed(adminSession));
  assertEquals(resp.status, 200);
  const rows = (await resp.json()) as SerializedBackoffRow[];
  assertEquals(rows.length, 2);
  const pairs = rows.map(r => `${r.proxy_id}/${r.upstream_id}`).sort();
  assertEquals(pairs, ['p_a/up_a', 'p_b/up_b']);
});

test('POST /api/proxies/:id/backoffs/reset with no body clears every row for the proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_x', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_y', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_x', 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs/reset', authed(adminSession, {}));
  assertEquals(resp.status, 200);
  assertEquals(await resp.json(), { ok: true });

  assertEquals((await repo.proxyBackoffs.listForProxy('p_a')).length, 0);
  assertEquals((await repo.proxyBackoffs.listForProxy('p_b')).length, 1);
});

test('POST /api/proxies/:id/backoffs/reset with upstream_id clears only the matching pair', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_x', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_y', 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs/reset', authed(adminSession, { upstream_id: 'up_x' }));
  assertEquals(resp.status, 200);

  const rows = await repo.proxyBackoffs.listForProxy('p_a');
  assertEquals(rows.length, 1);
  assertEquals(rows[0].upstreamId, 'up_y');
});
