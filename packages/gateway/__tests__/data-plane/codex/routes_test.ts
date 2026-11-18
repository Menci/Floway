import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountCodexRoutes } from '../../../src/data-plane/codex/routes.ts';
import { type AuthVars, authMiddleware } from '../../../src/middleware/auth.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildChatGPTUpstreamRecord, copilotModels, requestApp, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildCodexApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', authMiddleware);
  mountCodexRoutes(app);
  return app;
};

const copilotFetch = (models: Array<{ id: string; maxContextWindowTokens?: number; maxPromptTokens?: number; supported_endpoints?: string[] }>) =>
  (request: Request): Response => {
    const url = new URL(request.url);
    if (url.hostname === 'update.code.visualstudio.com') {
      return jsonResponse(['1.110.1']);
    }
    if (url.pathname === '/copilot_internal/v2/token') {
      return jsonResponse({ token: 'test-copilot-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
    }
    if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
      return jsonResponse(copilotModels(models));
    }
    if (url.hostname === 'raw.githubusercontent.com') return new Response(null, { status: 404 });
    throw new Error(`Unhandled fetch ${request.url}`);
  };

const CODEX_USER_AGENT = 'codex_cli_rs/0.169.0';

interface CodexModelsResponse {
  models: Array<{
    slug: string;
    context_window?: number;
    max_context_window?: number;
    auto_compact_token_limit?: number | null;
  }>;
}

const requestCodexModels = async (apiKey: string): Promise<Response> => {
  await warmModelsForTest();
  return await buildCodexApp().request('/azure-api.codex/models', {
    headers: { authorization: `Bearer ${apiKey}`, 'user-agent': CODEX_USER_AGENT },
  });
};

describe('Codex model-provider routes', () => {
  it('preserves backend defaults and override ceilings through catalog refresh and both model routes', async () => {
    const { apiKey, repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await saveUpstreamForTest(repo.upstreams, buildChatGPTUpstreamRecord());
    const body = await withMockedFetch(
      (request: Request): Response => {
        const url = new URL(request.url);
        if (url.hostname === 'raw.githubusercontent.com') return new Response(null, { status: 404 });
        if (url.pathname === '/backend-api/codex/models') {
          return jsonResponse({
            models: [
              ...([['gpt-6.2-sol', 500000], ['gpt-6.2-astra', 272000]] as const).map(([slug, context_window]) => ({
                slug, display_name: slug, context_window, max_context_window: 872000, input_modalities: ['text', 'image'],
                service_tiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }], additional_speed_tiers: ['fast'],
                tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform', multi_agent_version: 'v2', multi_agent_reasoning_effort: 'xhigh',
                support_verbosity: true, default_verbosity: 'low', supports_reasoning_summary_parameter: true, supports_reasoning_summaries: true,
                supports_search_tool: true, supports_reasoning_effort_updates: true, experimental_supported_tools: ['clock', 'multi_agent_v2_in_code_mode'],
                supported_reasoning_levels: ['xhigh', 'max', 'ultra'].map(effort => ({ effort })),
              })),
              { slug: 'audio-model', display_name: 'Audio', context_window: 64000, input_modalities: ['text', 'audio'], service_tiers: [{ id: 'ultrafast', name: 'Ultrafast', description: 'Account tier' }] },
              { slug: 'video-only', display_name: 'Video', context_window: 64000, input_modalities: ['video'] },
              { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', context_window: 272000, max_context_window: 872000 },
              { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, max_context_window: 272000 },
              { slug: 'future-model', display_name: 'Future Model', context_window: 80000, max_context_window: 600000 },
              { slug: 'uncapped-model', display_name: 'Uncapped Model', context_window: 64000 },
            ],
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const namespaced = await requestCodexModels(apiKey.key);
        const sharedCatalog = await requestApp('/models', {
          headers: { authorization: `Bearer ${apiKey.key}`, 'user-agent': CODEX_USER_AGENT },
        });
        expect(namespaced.status).toBe(200);
        expect(sharedCatalog.status).toBe(200);
        const catalog = await namespaced.json() as CodexModelsResponse;
        expect(await sharedCatalog.json()).toEqual(catalog);
        const old = await requestApp('/models', { headers: { authorization: `Bearer ${apiKey.key}`, 'user-agent': 'codex_cli_rs/0.144.0' } });
        expect((await old.json() as CodexModelsResponse).models.find(m => m.slug === 'audio-model')).toMatchObject({ input_modalities: ['text'] });
        return catalog;
      },
    );
    const bySlug = Object.fromEntries(body.models.map(model => [model.slug, model]));
    for (const [slug, context_window] of [['gpt-6.2-sol', 500000], ['gpt-6.2-astra', 272000]] as const) expect(bySlug[slug]).toMatchObject({
      context_window, max_context_window: 872000,
      service_tiers: [{ id: 'priority', name: 'Fast', description: 'Faster responses' }], additional_speed_tiers: ['fast'],
      input_modalities: ['text', 'image'], tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform',
      multi_agent_version: 'v2', multi_agent_reasoning_effort: 'xhigh',
      support_verbosity: true, default_verbosity: 'low', supports_reasoning_summary_parameter: true, supports_reasoning_summaries: true,
      supports_search_tool: true, supports_reasoning_effort_updates: true, experimental_supported_tools: ['clock', 'multi_agent_v2_in_code_mode'],
    });
    expect(bySlug['audio-model']).toMatchObject({ input_modalities: ['text', 'audio'], service_tiers: [{ id: 'ultrafast', name: 'Ultrafast', description: 'Account tier' }] });
    expect(bySlug).not.toHaveProperty('video-only');
    expect(bySlug['gpt-6.1-sol']).toMatchObject({ context_window: 272000, max_context_window: 872000, auto_compact_token_limit: null });
    expect(bySlug['gpt-5.5']).toMatchObject({ context_window: 272000, max_context_window: 272000 });
    expect(bySlug['future-model']).toMatchObject({ context_window: 80000, max_context_window: 600000, auto_compact_token_limit: null });
    expect(bySlug['uncapped-model']).toMatchObject({ context_window: 64000 });
    expect(bySlug['uncapped-model']).not.toHaveProperty('max_context_window');
    const stored = await repo.upstreams.getById('up_chatgpt');
    expect(stored?.modelsCache?.models.find(model => model.id === 'gpt-6.1-sol')?.limits.max_context_window_tokens).toBe(872000);
  });

  it('caps a same-named OpenAI model at the actual Copilot input limit', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'gpt-6.1-sol', maxContextWindowTokens: 1000000, maxPromptTokens: 936000 }]),
      async () => {
        const response = await requestCodexModels(apiKey.key);
        expect(response.status).toBe(200);
        return await response.json() as CodexModelsResponse;
      },
    );
    expect(body.models.find(model => model.slug === 'gpt-6.1-sol')).toMatchObject({
      context_window: 936000,
      max_context_window: 936000,
      auto_compact_token_limit: null,
    });
  });

  it('owns the namespaced alpha-search path', async () => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request('/azure-api.codex/alpha/search', {
      method: 'POST',
      body: JSON.stringify({ commands: {} }),
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: expect.stringContaining('No web search commands were provided') });
  });

  it.each(['/alpha/search', '/v1/alpha/search'])('does not mount the general alpha-search alias %s', async path => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request(path, {
      method: 'POST',
      body: JSON.stringify({ commands: {} }),
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    });

    expect(response.status).toBe(404);
  });

  it.each([
    { method: 'GET', path: '/azure-api.codex/wham/agent-identities/jwks' },
    { method: 'POST', path: '/azure-api.codex/codex/analytics-events/events' },
    { method: 'POST', path: '/azure-api.codex/api/codex/apps' },
    { method: 'GET', path: '/azure-api.codex/plugins/featured' },
    { method: 'GET', path: '/azure-api.codex/plugins/list' },
    { method: 'GET', path: '/azure-api.codex/ps/plugins/list' },
    { method: 'GET', path: '/azure-api.codex/ps/plugins/installed' },
  ])('does not emulate the account-backed route $path', async ({ method, path }) => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request(path, {
      method,
      headers: { authorization: `Bearer ${apiKey.key}` },
    });

    expect(response.status).toBe(404);
  });

  it('mounts the OpenAI Responses WebSocket transport at the provider-relative path', async () => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request('/azure-api.codex/responses', {
      headers: { authorization: `Bearer ${apiKey.key}` },
    });

    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({ error: 'Expected Upgrade: websocket' });
  });

  it('writes both context-window fields from the registry and leaves automatic compaction at the Codex default', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
      async () => {
        const response = await requestCodexModels(apiKey.key);
        expect(response.status).toBe(200);
        return await response.json() as CodexModelsResponse;
      },
    );

    expect(body.models.find(model => model.slug === 'gpt-5.5')).toMatchObject({
      context_window: 1050000,
      max_context_window: 1050000,
      auto_compact_token_limit: null,
    });
  });

  it('downgrades a bundled maximum when the registry advertises a smaller limit', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'gpt-5.4', maxContextWindowTokens: 272000 }]),
      async () => {
        const response = await requestCodexModels(apiKey.key);
        expect(response.status).toBe(200);
        return await response.json() as CodexModelsResponse;
      },
    );

    const model = body.models.find(candidate => candidate.slug === 'gpt-5.4');
    expect(model?.context_window).toBe(272000);
    expect(model?.max_context_window).toBe(272000);
  });

  it('emits only bundled entries resolved from registry models', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'gpt-5.5', maxContextWindowTokens: 1050000 }]),
      async () => await (await requestCodexModels(apiKey.key)).json() as CodexModelsResponse,
    );

    expect(body.models.map(model => model.slug)).toEqual(['gpt-5.5']);
  });

  it('synthesizes catalog metadata for registry chat models without a bundled match', async () => {
    const { apiKey } = await setupAppTest();
    const body = await withMockedFetch(
      copilotFetch([{ id: 'claude-sonnet-4', supported_endpoints: ['/v1/messages'] }]),
      async () => await (await requestCodexModels(apiKey.key)).json() as CodexModelsResponse,
    );

    expect(body.models).toHaveLength(1);
    expect(body.models[0].slug).toBe('claude-sonnet-4');
  });
});
