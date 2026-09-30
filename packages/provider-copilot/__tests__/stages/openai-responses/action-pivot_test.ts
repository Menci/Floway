import { test, vi } from 'vitest';

import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

type Facts = { 'request.provider.payload': CanonicalOpenAIResponsesPayload; 'request.provider.responsesAction': 'generate' | 'compact' };

vi.mock('../../../src/stages/openai-responses/force-store-false.ts', () => ({
  copilotOpenAIResponsesForceStoreFalse: defineStage<Facts, Facts, object, object>({
    name: 'pivotCompactToGenerate',
    through: {
      request: { needs: ['request.provider.payload', 'request.provider.responsesAction'], consumes: ['request.provider.payload', 'request.provider.responsesAction'], provides: ['request.provider.payload', 'request.provider.responsesAction'] },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, next) => move({ ...await next(move({ ...facts, 'request.provider.payload': { ...facts['request.provider.payload'], store: false }, 'request.provider.responsesAction': 'generate' })) }),
  }),
}));

// Resolve the provider assembly after installing the request-stage fixture.
const { clearInProcessCopilotTokenCache } = await import('../../../src/auth.ts');
const { createCopilotProvider } = await import('../../../src/provider.ts');
const { createInMemoryImageProcessor, initImageProcessor } = await import('@floway-dev/platform');
const { directFetcher, initProviderRepo } = await import('@floway-dev/provider');
const { collectChatProviderPipeline, jsonResponse, noopUpstreamCallOptions, sseResponse, withMockedFetch } = await import('@floway-dev/test-utils');
type UpstreamRecord = import('@floway-dev/provider').UpstreamRecord;

test('Copilot dispatch and decoding follow the action changed by a stage (compact→generate)', async () => {
  const upstream: UpstreamRecord = {
    id: 'up_copilot_pivot',
    kind: 'copilot',
    name: 'Copilot (pivot tester)',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      githubHost: 'github.com',
      githubToken: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
      user: { id: 1, login: 'tester', name: 'Test User', avatar_url: 'https://example.com/avatar.png' },
    },
  };
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => upstream,
      saveState: async () => {},
    },
  }));
  initImageProcessor(createInMemoryImageProcessor());
  clearInProcessCopilotTokenCache();

  const instance = createCopilotProvider(upstream);
  const provider = instance.instance;

  let openaiResponsesBody: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse({
          object: 'list',
          data: [{
            id: 'gpt-resp',
            name: 'gpt-resp',
            version: '1',
            supported_endpoints: ['/responses'],
            capabilities: { type: 'chat', limits: {} },
          }],
        });
      }
      if (url.pathname === '/responses') {
        openaiResponsesBody = (await request.json()) as Record<string, unknown>;
        return sseResponse();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      const result = await collectChatProviderPipeline(instance, 'openaiResponsesCompact', providerModel, {
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      }, undefined, noopUpstreamCallOptions());
      if (result.output === null || !('kind' in result.output) || result.output.kind !== 'stream') throw new Error('expected generate stream after action pivot');
      assertEquals(result.facts['response.provider.responsesAction'], 'generate');
    },
  );

  if (!openaiResponsesBody) throw new Error('expected /responses to be hit');
  assertEquals(openaiResponsesBody.stream, true);
  const wireInput = openaiResponsesBody.input as Array<{ type: string }>;
  assertEquals(wireInput.some(item => item.type === 'compaction_trigger'), false);
});
