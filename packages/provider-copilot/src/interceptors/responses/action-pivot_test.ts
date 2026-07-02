import { test, vi } from 'vitest';

import type { ResponsesBoundaryCtx } from './types.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProviderResponsesResult } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

// `provider.callResponses` runs the boundary chain and the terminal
// switches on `ctx.action`, not on the closure-captured `action` parameter
// — so an interceptor that flips `ctx.action` mid-chain reroutes dispatch.
// To prove that contract end-to-end, swap the boundary chain for one
// containing a pivot interceptor (compact → generate) via `vi.mock`,
// then drive `provider.callResponses(model, body, 'compact', ...)`. The
// observed wire request must be the streaming /responses shape
// (stream:true, no `compaction_trigger`), and the typed result must
// surface as the `action: 'generate'` variant.
const pivotCompactToGenerate: Interceptor<ResponsesBoundaryCtx, object, ProviderResponsesResult> = async (ctx, _request, run) => {
  ctx.action = 'generate';
  return await run();
};

vi.mock('./index.ts', async () => {
  const original = await vi.importActual<typeof import('./index.ts')>('./index.ts');
  return {
    ...original,
    COPILOT_RESPONSES_BOUNDARY: [...original.COPILOT_RESPONSES_BOUNDARY, pivotCompactToGenerate],
  };
});

// Imports below MUST follow the vi.mock so the provider module resolves
// against the mocked chain on first import.
const { clearInProcessCopilotTokenCache } = await import('../../auth.ts');
const { createCopilotProvider } = await import('../../provider.ts');
const { createInMemoryImageProcessor, initImageProcessor } = await import('@floway-dev/platform');
const { directFetcher, initProviderRepo } = await import('@floway-dev/provider');
const { jsonResponse, noopUpstreamCallOptions, sseResponse, withMockedFetch } = await import('@floway-dev/test-utils');
type UpstreamRecord = import('@floway-dev/provider').UpstreamRecord;

test('Copilot provider terminal dispatches on post-chain ctx.action (interceptor flip compact→generate routes to the streaming generate path)', async () => {
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
    config: {
      githubToken: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
      user: { id: 1, login: 'tester', name: 'Test User', avatar_url: 'https://example.com/avatar.png' },
    },
  };
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => upstream,
      saveState: async () => ({ updated: true }),
    },
  }));
  initImageProcessor(createInMemoryImageProcessor());
  clearInProcessCopilotTokenCache();

  const instance = await createCopilotProvider(upstream);
  const provider = instance.instance;

  let responsesBody: Record<string, unknown> | undefined;
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
        responsesBody = (await request.json()) as Record<string, unknown>;
        return sseResponse();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await provider.getProvidedModels(directFetcher);
      const result = await provider.callResponses(providerModel, {
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      }, 'compact', undefined, noopUpstreamCallOptions());
      if (!result.ok) throw new Error('expected ok result');
      if (result.action !== 'generate') throw new Error(`expected generate variant after pivot, got ${result.action}`);
    },
  );

  if (!responsesBody) throw new Error('expected /responses to be hit');
  // Stream-true wire shape proves the terminal took the generate branch,
  // not the synth-via-trigger compact branch.
  assertEquals(responsesBody.stream, true);
  const wireInput = responsesBody.input as Array<{ type: string }>;
  assertEquals(wireInput.some(item => item.type === 'compaction_trigger'), false);
});
