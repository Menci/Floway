import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { mountCodexRoutes } from '../../../src/data-plane/codex/routes.ts';
import { type AuthVars, authMiddleware } from '../../../src/middleware/auth.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildChatGPTUpstreamRecord, requestApp, setupAppTest, warmModelsForTest } from '../../test-utils/app.ts';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildCodexApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', authMiddleware);
  mountCodexRoutes(app);
  return app;
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
    expect(bySlug['future-model']).not.toHaveProperty('multi_agent_version');
    expect(bySlug['uncapped-model']).toMatchObject({ context_window: 64000 });
    expect(bySlug['uncapped-model']).not.toHaveProperty('max_context_window');
    const stored = await repo.upstreams.getById('up_chatgpt');
    expect(stored?.modelsCache?.models.find(model => model.id === 'gpt-6.1-sol')?.limits.max_context_window_tokens).toBe(872000);
  });

  it('owns the namespaced alpha-search path', async () => {
    const { apiKey } = await setupAppTest();
    const response = await buildCodexApp().request('/azure-api.codex/alpha/search', {
      method: 'POST',
      body: JSON.stringify({ commands: {} }),
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ output: expect.any(String) });
  });
});
