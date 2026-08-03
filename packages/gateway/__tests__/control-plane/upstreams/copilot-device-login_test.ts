import { test, vi } from 'vitest';

// Copilot OAuth poll handlers warm the model cache after rotating the PAT. The
// cache behavior has dedicated coverage; these route tests isolate credential
// exchange and persistence.
vi.mock('../../../src/data-plane/providers/models-cache.ts', () => ({
  fetchUpstreamModelsCached: () => Promise.resolve([]),
  clearInFlightForTesting: () => {},
}));

import { buildCopilotUpstreamRecord, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, assertStringIncludes, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const githubUser = {
  id: 777,
  login: 'octo-auth',
  name: 'Octo Auth',
  avatar_url: 'https://example.com/octo-auth.png',
};

test('/api/upstreams/copilot/oauth/device-login/start starts GitHub device flow', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/device/code') {
        return jsonResponse({ device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/oauth/device-login/start', { method: 'POST', headers: { 'x-floway-session': adminSession } });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { device_code: 'device', user_code: 'ABCD', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    },
  );
});

// The blueprint envelope shape the SPA sends when the operator has not yet
// saved a Copilot row. Matches `blueprintUpstreamRecord('copilot')` on the
// wire — the exchange endpoint only reads `id`, `kind`, and
// `proxy_fallback_list` from the envelope, so a minimal literal keeps the
// test focused on the exchange semantics.
const copilotBlueprintEnvelope = { id: '', kind: 'copilot', config: null, state: null, proxy_fallback_list: MOCKED_FETCH_EGRESS };

test('/api/upstreams/copilot/oauth/device-login/poll returns a config+state patch and identity from the token exchange', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_new' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'ct_new',
          expires_at: Math.floor(Date.now() / 1000) + 1500,
          refresh_in: 1200,
          endpoints: { api: 'https://api.enterprise.githubcopilot.com' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/oauth/device-login/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ record: copilotBlueprintEnvelope, deviceCode: 'device' }),
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as { status: string; user: { id: number }; patch: { config: { githubToken: string; user: { id: number } }; state: { copilotToken: { token: string; baseUrl: string } } } };
      assertEquals(body.status, 'complete');
      assertEquals(body.user.id, githubUser.id);
      // Create-flow returns the raw patch — no DB write happens here; the
      // SPA merges it into the draft and calls POST /api/upstreams to save.
      assertEquals(body.patch.config.githubToken, 'ghu_new');
      assertEquals(body.patch.config.user.id, githubUser.id);
      assertEquals(body.patch.state.copilotToken.token, 'ct_new');
      assertEquals(body.patch.state.copilotToken.baseUrl, 'https://api.enterprise.githubcopilot.com');
    },
  );

  // No DB write during create-flow poll — persistence is the caller's
  // subsequent POST /api/upstreams.
  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/oauth/device-login/poll rejects failed GitHub user lookup with 502 and no side-effect', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_no_user' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse({ message: 'bad credentials' }, 401);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/oauth/device-login/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ record: copilotBlueprintEnvelope, deviceCode: 'device' }),
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: string };
      assertStringIncludes(body.error, 'GitHub user lookup failed: 401');
      assertStringIncludes(body.error, 'bad credentials');
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/oauth/device-login/poll rejects a failed token exchange with 502 and no side-effect', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_no_seat' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/v2/token') return jsonResponse({ message: 'no copilot seat' }, 403);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/oauth/device-login/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ record: copilotBlueprintEnvelope, deviceCode: 'device' }),
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: string };
      assertStringIncludes(body.error, 'Copilot token fetch failed: 403');
      assertStringIncludes(body.error, 'no copilot seat');
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/oauth/device-login/poll rejects a token-exchange response missing endpoints.api with 502 and no side-effect', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_no_endpoint' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'ct_no_endpoint', expires_at: Math.floor(Date.now() / 1000) + 1500, refresh_in: 1200 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/oauth/device-login/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ record: copilotBlueprintEnvelope, deviceCode: 'device' }),
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: string };
      assertStringIncludes(body.error, 'endpoints.api');
    },
  );

  assertEquals(await repo.upstreams.list(), []);
});

test('/api/upstreams/copilot/oauth/device-login/poll targeted-patches config+state on the row identified by record.id', async () => {
  const { repo, adminSession, githubAccount } = await setupAppTest({
    githubAccount: {
      token: 'ghu_old',
      user: githubUser,
    },
  });
  const existing = buildCopilotUpstreamRecord(githubAccount, { id: 'up_existing_copilot', name: 'Pinned Copilot', sortOrder: 9 });
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(existing);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') return jsonResponse({ access_token: 'ghu_refreshed' });
      if (url.hostname === 'api.github.com' && url.pathname === '/user') return jsonResponse(githubUser);
      if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'ct_refreshed',
          expires_at: Math.floor(Date.now() / 1000) + 1500,
          refresh_in: 1200,
          endpoints: { api: 'https://api.business.githubcopilot.com' },
        });
      }
      // Warmup probes /models on the per-tier host — return an empty catalog
      // so the post-persist warm completes without waiting on a real fetch.
      if (url.hostname === 'api.business.githubcopilot.com') return jsonResponse({ data: [] });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/upstreams/copilot/oauth/device-login/poll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ record: { ...copilotBlueprintEnvelope, id: 'up_existing_copilot' }, deviceCode: 'device' }),
      });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { status: string; patch: { config: { githubToken: string } } };
      assertEquals(body.status, 'complete');
      assertEquals(body.patch.config.githubToken, 'ghu_refreshed');
    },
  );

  const rows = await repo.upstreams.list();
  assertEquals(rows.length, 1);
  // The row-metadata fields (id, name, sortOrder) survive; only config +
  // state are overwritten by the credential patch.
  assertEquals(rows[0].id, 'up_existing_copilot');
  assertEquals(rows[0].name, 'Pinned Copilot');
  assertEquals(rows[0].sortOrder, 9);
  assertEquals((rows[0].config as Record<string, any>).githubToken, 'ghu_refreshed');
  const persistedState = rows[0].state as { copilotToken: { baseUrl: string } | null } | null;
  assertEquals(persistedState?.copilotToken?.baseUrl, 'https://api.business.githubcopilot.com');
});
