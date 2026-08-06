import { afterEach, expect, test, vi } from 'vitest';

import type { SerializedBackoffRow, SerializedProxyRecord } from '../../../src/control-plane/proxies/serialize.ts';
import { requestApp, setupAppTest } from '../../test-utils/app.ts';
import { initSocketDial, resetSocketDialForTesting, type SocketDial } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

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

test('GET /api/proxies returns the complete serialized proxy record', async () => {
  const { repo, adminSession } = await setupAppTest();
  const stored = await repo.proxies.insert({ id: 'p_a', name: 'First', url: HTTP_URL, dialTimeoutSeconds: 45 });

  const resp = await requestApp('/api/proxies', authed(adminSession));
  assertEquals(resp.status, 200);
  const list = (await resp.json()) as SerializedProxyRecord[];
  assertEquals(list, [{
    id: 'p_a',
    name: 'First',
    url: HTTP_URL,
    created_at: stored.createdAt,
    updated_at: stored.updatedAt,
    dial_timeout_seconds: 45,
  }]);
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
  const { repo, adminSession } = await setupAppTest();

  const resp = await requestApp('/api/proxies', authed(adminSession, { name: 'Bad', url: 'gibberish' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error?: string };
  assertEquals(body.error?.startsWith('Invalid proxy URI:'), true);
  // Pin no doubled prefix: parseProxyUri's URL-constructor branch raises
  // 'malformed proxy URI: …'; the wrapper must strip that internal prefix
  // so the operator sees a single 'Invalid proxy URI: …' framing.
  assertEquals(body.error?.includes('proxy URI: malformed proxy URI'), false);
  assertEquals(await repo.proxies.list(), []);
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

test('PATCH /api/proxies/:id rejects an invalid URL without mutating config or backoff', async () => {
  const { repo, adminSession } = await setupAppTest();
  const before = await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, dialTimeoutSeconds: 30 });
  await repo.proxyBackoffs.recordDialFailure('p1', 'up_a', HTTP_URL, 'boom');

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { name: 'New', url: 'not-a-proxy-uri' }));
  assertEquals(resp.status, 400);
  assertEquals(await repo.proxies.getById('p1'), before);
  assertEquals((await repo.proxyBackoffs.listForProxy('p1')).length, 1);
});

test('PATCH /api/proxies/:id returns 404 for an unknown proxy', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/proxies/missing', patchAuthed(adminSession, { name: 'New' }));
  assertEquals(resp.status, 404);
  assertEquals(await resp.json(), { error: 'Proxy not found' });
});

test('PATCH /api/proxies/:id with a new URL makes old-generation backoffs inactive', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p1', 'up_a', HTTP_URL, 'boom');
  await repo.proxyBackoffs.recordDialFailure('p1', 'up_b', HTTP_URL, 'boom');

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { url: SOCKS_URL }));
  assertEquals(resp.status, 200);

  assertEquals((await repo.proxyBackoffs.listForProxy('p1')).length, 0);
});

test('PATCH /api/proxies/:id with the identical URL leaves backoff rows intact', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p1', 'up_a', HTTP_URL, 'boom');

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminSession, { name: 'Renamed', url: HTTP_URL }));
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

test('proxy control schemas enforce inclusive resource boundaries and malformed discriminants', async () => {
  const { repo, adminSession } = await setupAppTest();
  const create = await requestApp('/api/proxies', authed(adminSession, {
    name: 'x'.repeat(200),
    url: SOCKS_URL,
    dial_timeout_seconds: 1,
  }));
  assertEquals(create.status, 201);
  const created = (await create.json()) as SerializedProxyRecord;

  const maximum = await requestApp(`/api/proxies/${created.id}`, patchAuthed(adminSession, { dial_timeout_seconds: 600 }));
  assertEquals(maximum.status, 200);
  assertEquals(((await maximum.json()) as SerializedProxyRecord).dial_timeout_seconds, 600);
  await repo.proxyBackoffs.recordDialFailure(created.id, 'up_x', SOCKS_URL, 'boom');

  const malformed: Array<readonly [string, RequestInit]> = [
    ['/api/proxies', authed(adminSession, { name: '', url: HTTP_URL })],
    ['/api/proxies', authed(adminSession, { name: 'x'.repeat(201), url: HTTP_URL })],
    ['/api/proxies', authed(adminSession, { name: 'Proxy', url: '' })],
    ['/api/proxies', authed(adminSession, { name: 'Proxy', url: HTTP_URL, dial_timeout_seconds: 0 })],
    [`/api/proxies/${created.id}`, patchAuthed(adminSession, { dial_timeout_seconds: 601 })],
    [`/api/proxies/${created.id}`, patchAuthed(adminSession, { dial_timeout_seconds: 1.5 })],
    [`/api/proxies/${created.id}`, patchAuthed(adminSession, { dial_timeout_seconds: '1' })],
    ['/api/proxies/test', authed(adminSession, { url: HTTP_URL, anchor: 'unknown-anchor' })],
    [`/api/proxies/${created.id}/backoffs/reset`, authed(adminSession, { upstream_id: '' })],
  ];
  for (const [path, init] of malformed) {
    const response = await requestApp(path, init);
    assertEquals(response.status, 400, `${init.method} ${path} must reject malformed input`);
  }

  assertEquals((await repo.proxies.list()).length, 1);
  assertEquals((await repo.proxies.getById(created.id))?.dialTimeoutSeconds, 600);
  assertEquals((await repo.proxyBackoffs.listForProxy(created.id)).length, 1);
});

test('DELETE /api/proxies/:id returns 204 when no upstream references the proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_del', name: 'Doomed', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxies.insert({ id: 'p_keep', name: 'Kept', url: SOCKS_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p_del', 'up_a', HTTP_URL, 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_keep', 'up_a', SOCKS_URL, 'boom');

  const resp = await requestApp('/api/proxies/p_del', deleteAuthed(adminSession));
  assertEquals(resp.status, 204);
  assertEquals(await repo.proxies.getById('p_del'), null);
  assertEquals(await repo.proxyBackoffs.listForProxy('p_del'), []);
  assertEquals((await repo.proxyBackoffs.listForProxy('p_keep')).length, 1);
});

test('DELETE /api/proxies/:id returns 404 when the proxy does not exist', async () => {
  const { adminSession } = await setupAppTest();
  const resp = await requestApp('/api/proxies/missing', deleteAuthed(adminSession));
  assertEquals(resp.status, 404);
  assertEquals(await resp.json(), { error: 'Proxy not found' });
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

test('DELETE /api/proxies/:id returns 409 when a reference appears between lookup and delete', async () => {
  const { repo, adminSession, copilotUpstream } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_race', name: 'Raced', url: HTTP_URL, dialTimeoutSeconds: null });
  const realDelete = repo.proxies.delete.bind(repo.proxies);
  repo.proxies.delete = async id => {
    const updated = await repo.upstreams.updateFields(copilotUpstream.id, 'copilot', {
      proxyFallbackList: [{ id }],
      updatedAt: new Date(Date.parse(copilotUpstream.updatedAt) + 1).toISOString(),
    });
    assertExists(updated);
    return await realDelete(id);
  };

  const resp = await requestApp('/api/proxies/p_race', deleteAuthed(adminSession));
  assertEquals(resp.status, 409);
  assertEquals(await resp.json(), {
    error: 'Proxy is referenced by upstreams',
    referencing_upstream_ids: [copilotUpstream.id],
  });
  assertExists(await repo.proxies.getById('p_race'));
});

test('POST /api/proxies/test runs against the body URL without touching any row', async () => {
  const { repo, adminSession } = await setupAppTest();
  const connect = vi.fn<SocketDial['connect']>(async () => {
    throw new Error('stub: dial refused');
  });
  initSocketDial({ connect });

  const resp = await requestApp('/api/proxies/test', authed(adminSession, { url: HTTP_URL }));
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { ok: boolean; error?: string; egress_ip?: string };
  assertEquals(body, { ok: false, error: '[tcp-connect] tcp connect to 198.51.100.20:3128 failed' });
  expect(connect).toHaveBeenCalledOnce();
  expect(connect.mock.calls[0]?.slice(0, 2)).toEqual(['198.51.100.20', 3128]);

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

test('POST /api/proxies/test propagates an internal dependency failure with its stack', async () => {
  const { adminSession } = await setupAppTest();
  resetSocketDialForTesting();
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const resp = await requestApp('/api/proxies/test', authed(adminSession, { url: HTTP_URL }));
    assertEquals(resp.status, 500);
    const body = (await resp.json()) as { error: { type: string; message: string; stack?: string; method: string; path: string } };
    expect(body.error).toMatchObject({
      type: 'internal_error',
      message: 'SocketDial not initialized',
      method: 'POST',
      path: '/api/proxies/test',
    });
    expect(body.error.stack).toContain('SocketDial not initialized');
  } finally {
    errorSpy.mockRestore();
  }
});

test('GET /api/proxies/:id/backoffs returns rows scoped to the proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxies.insert({ id: 'p_b', name: 'B', url: SOCKS_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_a', HTTP_URL, 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_a', SOCKS_URL, 'boom');
  const [stored] = await repo.proxyBackoffs.listForProxy('p_a');
  assertExists(stored);

  const resp = await requestApp('/api/proxies/p_a/backoffs', authed(adminSession));
  assertEquals(resp.status, 200);
  const rows = (await resp.json()) as SerializedBackoffRow[];
  assertEquals(rows, [{
    proxy_id: 'p_a',
    upstream_id: 'up_a',
    fail_count: 1,
    expires_at: stored.expiresAt,
    last_error: 'boom',
    last_error_at: stored.lastErrorAt,
  }]);
});

test('GET /api/proxies/backoffs returns every backoff row regardless of proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxies.insert({ id: 'p_b', name: 'B', url: SOCKS_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_a', HTTP_URL, 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_b', SOCKS_URL, 'kaboom');

  const resp = await requestApp('/api/proxies/backoffs', authed(adminSession));
  assertEquals(resp.status, 200);
  const rows = (await resp.json()) as SerializedBackoffRow[];
  assertEquals(rows.length, 2);
  const pairs = rows.map(r => `${r.proxy_id}/${r.upstream_id}`).sort();
  assertEquals(pairs, ['p_a/up_a', 'p_b/up_b']);
});

test('POST /api/proxies/:id/backoffs/reset with no body clears every row for the proxy', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxies.insert({ id: 'p_b', name: 'B', url: SOCKS_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_x', HTTP_URL, 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_y', HTTP_URL, 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_x', SOCKS_URL, 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs/reset', authed(adminSession, {}));
  assertEquals(resp.status, 200);
  assertEquals(await resp.json(), { ok: true });

  assertEquals((await repo.proxyBackoffs.listForProxy('p_a')).length, 0);
  assertEquals((await repo.proxyBackoffs.listForProxy('p_b')).length, 1);
});

test('POST /api/proxies/:id/backoffs/reset with upstream_id clears only the matching pair', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: HTTP_URL, dialTimeoutSeconds: null });
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_x', HTTP_URL, 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_y', HTTP_URL, 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs/reset', authed(adminSession, { upstream_id: 'up_x' }));
  assertEquals(resp.status, 200);

  const rows = await repo.proxyBackoffs.listForProxy('p_a');
  assertEquals(rows.length, 1);
  assertEquals(rows[0].upstreamId, 'up_y');
});
