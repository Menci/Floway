import { test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, copilotModels, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assert, assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const azureUpstream = (): UpstreamRecord => ({
  id: 'up_azure_models',
  kind: 'azure',
  name: 'Azure Models',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 200,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
  },
  state: null,
});

test('/api/models exposes each upstream as { kind, id } so multi-provider models are unambiguous', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await saveUpstreamForTest(repo.upstreams, azureUpstream(), {
    manualModels: [{
      upstreamModelId: 'azure-model',
      publicModelId: 'azure-public',
      kind: 'chat',
      endpoints: { openaiResponses: {} },
    }],
  });

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
      const response = await requestAppWithWarmModels('/api/models', { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { data: Array<Record<string, unknown>> };

      assertEquals(body.data.find(model => model.id === 'claude-sonnet-4')?.upstreams, [{ kind: 'copilot', id: 'up_copilot', name: 'GitHub Copilot (tester)', hue: 210 }]);
      assertEquals(body.data.find(model => model.id === 'custom-model')?.upstreams, [{ kind: 'custom', id: 'up_custom_models', name: 'Custom Provider', hue: 210 }]);
      assertEquals(body.data.find(model => model.id === 'azure-public')?.upstreams, [{ kind: 'azure', id: 'up_azure_models', name: 'Azure Models', hue: 210 }]);
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

test('/api/models — admin sees raw alias.targets; non-admin sees the caller-narrowed projection', async () => {
  // Wire an alias with a typo target + one real target. Admin must see
  // the typo (so the alias-edit dialog can render it for fixing); a
  // non-admin who can reach the real target must see only that target
  // — never the typo, never out-of-cap target ids.
  const { adminSession, repo } = await setupAppTest();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.modelAliases.insert({
    id: 'alias_mix',
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

  const nonAdminSession = (await repo.sessions.create(2)).id;

  await withMockedFetch(modelsFetchHandler, async () => {
    const adminResponse = await requestAppWithWarmModels('/api/models', { headers: { 'x-floway-session': adminSession } });
    assertEquals(adminResponse.status, 200);
    const adminBody = (await adminResponse.json()) as { data: Array<{ id: string; aliasedFrom?: { targets: Array<{ target_model_id: string }> } }> };
    const adminMix = adminBody.data.find(m => m.id === 'mix');
    assert(adminMix !== undefined);
    assertEquals(
      adminMix!.aliasedFrom?.targets.map(t => t.target_model_id),
      ['custom-model', 'typo-no-such-model'],
    );

    const nonAdminResponse = await requestAppWithWarmModels('/api/models', { headers: { 'x-floway-session': nonAdminSession } });
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
