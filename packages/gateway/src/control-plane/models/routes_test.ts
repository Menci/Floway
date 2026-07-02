import { test } from 'vitest';

import { buildCustomUpstreamRecord, copilotModels, requestApp, setupAppTest } from '../../test-helpers.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assert, assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const azureUpstream = (): UpstreamRecord => ({
  id: 'up_azure_models',
  kind: 'azure',
  name: 'Azure Models',
  enabled: true,
  sortOrder: 200,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'azure-model',
        publicModelId: 'azure-public',
        endpoints: { responses: {} },
      },
    ],
  },
  state: null,
});

test('/api/models exposes each upstream as { kind, id } so multi-provider models are unambiguous', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.upstreams.save(azureUpstream());

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-model', supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/models', { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { data: Array<Record<string, unknown>> };

      assertEquals(body.data.find(model => model.id === 'claude-sonnet-4')?.upstreams, [{ kind: 'copilot', id: 'up_copilot', name: 'GitHub Copilot (tester)' }]);
      assertEquals(body.data.find(model => model.id === 'custom-model')?.upstreams, [{ kind: 'custom', id: 'up_custom_models', name: 'Custom Provider' }]);
      assertEquals(body.data.find(model => model.id === 'azure-public')?.upstreams, [{ kind: 'azure', id: 'up_azure_models', name: 'Azure Models' }]);
      for (const model of body.data) {
        // Legacy split fields must not reappear.
        assertEquals(Object.hasOwn(model, 'provider'), false);
        assertEquals(Object.hasOwn(model, 'upstream_ids'), false);
        assertEquals(Object.hasOwn(model, 'upstream_kind'), false);
      }
    },
  );
});

const modelsFetchHandler = (request: Request): Response => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
    return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', supported_endpoints: ['/v1/messages'] }]));
  }
  if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
    return jsonResponse({ object: 'list', data: [{ id: 'custom-model', supported_endpoints: ['/chat/completions'] }] });
  }
  throw new Error(`Unhandled fetch ${request.url}`);
};

test('/api/models is scoped to the caller\'s effective upstreams — a removed upstream\'s models disappear from the dashboard', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.upstreams.save(azureUpstream());

  // The seed tester (user 2) overrides their available upstreams to exclude
  // Azure, then browses the dashboard Models tab via a session token — the
  // exact path that previously leaked the full catalog regardless of the cap.
  await repo.users.save({
    id: 2,
    username: 'tester',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: ['up_copilot', 'up_custom_models'],
    canViewGlobalTelemetry: false,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });
  const session = (await repo.sessions.create(2)).id;

  await withMockedFetch(modelsFetchHandler, async () => {
    const response = await requestApp('/api/models', { headers: { 'x-floway-session': session } });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map(model => model.id).sort();

    assertEquals(ids, ['claude-sonnet-4', 'custom-model']);
    assertEquals(ids.includes('azure-public'), false);
  });
});

test('/api/models appends visible alias entries with aliasedFrom alongside real catalog rows', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));

  await withMockedFetch(modelsFetchHandler, async () => {
    const response = await requestApp('/api/models', { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string; display_name: string; upstreams: Array<{ kind: string; id: string; name: string }> }> };
    assertEquals(body.data.some(model => model.id === 'custom-model'), true);
  });
});

test('/api/models for an admin session returns the gateway-wide catalog, bypassing the admin\'s own user.upstreamIds cap', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.upstreams.save(azureUpstream());

  // Admin self-restricts. The dashboard's editor surfaces (alias edit,
  // upstream edit) need to see "what exists on the entire gateway", and
  // the Models page + playground filter the gateway-wide payload
  // client-side for surfaces that should respect the restriction.
  // Server-side gateway-wide for admin is the foundation that lets the
  // dashboard do that filtering.
  await repo.users.save({
    id: 1,
    username: 'admin',
    passwordHash: null,
    isAdmin: true,
    upstreamIds: ['up_copilot', 'up_custom_models'],
    canViewGlobalTelemetry: true,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });

  await withMockedFetch(modelsFetchHandler, async () => {
    const response = await requestApp('/api/models', { headers: { 'x-floway-session': adminSession } });
    assertEquals(response.status, 200);
    const ids = ((await response.json()) as { data: Array<{ id: string }> }).data.map(m => m.id).sort();
    assertEquals(ids.includes('azure-public'), true);
    assertEquals(ids.includes('custom-model'), true);
  });
});

test('/api/models — admin sees raw alias.targets; non-admin sees the caller-narrowed projection', async () => {
  // Wire an alias with a typo target + one real target. Admin must see
  // the typo (so the alias-edit dialog can render it for fixing); a
  // non-admin who can reach the real target must see only that target
  // — never the typo, never out-of-cap target ids.
  const { adminSession, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.modelAliases.insert({
    name: 'mix',
    kind: 'chat',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: true,
    targets: [
      { target_model_id: 'custom-model', rules: {} },
      { target_model_id: 'typo-no-such-model', rules: {} },
    ],
    announcedMetadata: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  // Non-admin user with access to the same upstream.
  await repo.users.save({
    id: 2,
    username: 'tester',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });
  const nonAdminSession = (await repo.sessions.create(2)).id;

  await withMockedFetch(modelsFetchHandler, async () => {
    const adminResponse = await requestApp('/api/models', { headers: { 'x-floway-session': adminSession } });
    assertEquals(adminResponse.status, 200);
    const adminBody = (await adminResponse.json()) as { data: Array<{ id: string; aliasedFrom?: { targets: Array<{ target_model_id: string }> } }> };
    const adminMix = adminBody.data.find(m => m.id === 'mix');
    assert(adminMix !== undefined);
    assertEquals(
      adminMix!.aliasedFrom?.targets.map(t => t.target_model_id),
      ['custom-model', 'typo-no-such-model'],
    );

    const nonAdminResponse = await requestApp('/api/models', { headers: { 'x-floway-session': nonAdminSession } });
    assertEquals(nonAdminResponse.status, 200);
    const nonAdminBody = (await nonAdminResponse.json()) as { data: Array<{ id: string; aliasedFrom?: { targets: Array<{ target_model_id: string }> } }> };
    const nonAdminMix = nonAdminBody.data.find(m => m.id === 'mix');
    assert(nonAdminMix !== undefined);
    // Typo `typo-no-such-model` is hidden; only the reachable target is exposed.
    assertEquals(
      nonAdminMix!.aliasedFrom?.targets.map(t => t.target_model_id),
      ['custom-model'],
    );
  });
});

test('/api/models — admin self-restriction does NOT leak per-alias metadata variation; non-admin and admin see identical limits/endpoints for the same alias', async () => {
  // Two upstreams advertising the same alias's targets, but with
  // different windows. Admin sees gateway-wide (limit = min over all).
  // Non-admin restricted to the larger-window upstream should still see
  // the same lower limit — metadata is a stable property of the alias,
  // not a per-caller derivation.
  const { adminSession, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_small',
    name: 'Small',
    sortOrder: 100,
    config: {
      baseUrl: 'https://small.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-small',
      endpoints: { chatCompletions: {} },
      models: [{ upstreamModelId: 'shared', publicModelId: 'shared', kind: 'chat', endpoints: { chatCompletions: {} }, limits: { max_context_window_tokens: 100_000 } }],
      modelsFetch: { enabled: false },
    },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_big',
    name: 'Big',
    sortOrder: 200,
    config: {
      baseUrl: 'https://big.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-big',
      endpoints: { chatCompletions: {} },
      models: [{ upstreamModelId: 'shared', publicModelId: 'shared', kind: 'chat', endpoints: { chatCompletions: {} }, limits: { max_context_window_tokens: 200_000 } }],
      modelsFetch: { enabled: false },
    },
  }));
  await repo.modelAliases.insert({
    name: 'shared-alias',
    kind: 'chat',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: true,
    targets: [{ target_model_id: 'shared', rules: {} }],
    announcedMetadata: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  // Non-admin user scoped to ONLY the big-window upstream.
  await repo.users.save({
    id: 2, username: 'tester', passwordHash: null, isAdmin: false,
    upstreamIds: ['up_big'], canViewGlobalTelemetry: false,
    createdAt: '2026-03-15T00:00:00.000Z', deletedAt: null,
  });
  const nonAdminSession = (await repo.sessions.create(2)).id;

  await withMockedFetch(() => { throw new Error('unexpected outbound fetch'); }, async () => {
    const [adminRes, nonAdminRes] = await Promise.all([
      requestApp('/api/models', { headers: { 'x-floway-session': adminSession } }),
      requestApp('/api/models', { headers: { 'x-floway-session': nonAdminSession } }),
    ]);
    const adminBody = (await adminRes.json()) as { data: Array<{ id: string; limits?: { max_context_window_tokens?: number } }> };
    const nonAdminBody = (await nonAdminRes.json()) as { data: Array<{ id: string; limits?: { max_context_window_tokens?: number } }> };
    const adminAlias = adminBody.data.find(m => m.id === 'shared-alias');
    const nonAdminAlias = nonAdminBody.data.find(m => m.id === 'shared-alias');
    assert(adminAlias !== undefined);
    assert(nonAdminAlias !== undefined);
    // Both callers see the safe-lower-bound window — even though the
    // non-admin's resolver would only ever pick the big-window
    // upstream's binding.
    assertEquals(adminAlias!.limits?.max_context_window_tokens, 100_000);
    assertEquals(nonAdminAlias!.limits?.max_context_window_tokens, 100_000);
  });
});
