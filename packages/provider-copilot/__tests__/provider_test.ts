import { test, vi } from 'vitest';

import { clearInProcessCopilotTokenCache } from '../src/auth.ts';
import { emptyKnownModels, mergeKnownModels } from '../src/known-models.ts';
import { createCopilotProvider } from '../src/provider.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from '../src/state.ts';
import { runPipeline } from '@floway-dev/pipeline';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import { directFetcher, initProviderRepo, readManagedBytes, toProviderModelFacts, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, sseResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const buildCopilotUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const { config: overrideConfig, ...rest } = overrides;
  return {
    id: 'up_copilot',
    kind: 'copilot',
    name: 'GitHub Copilot (tester)',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
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
    ...rest,
    config: overrideConfig ?? {
      githubHost: 'github.com',
      githubToken: `ghu_${crypto.randomUUID().replace(/-/g, '')}`,
      user: { id: 1, login: 'tester', name: 'Test User', avatar_url: 'https://example.com/avatar.png' },
    },
  };
};

interface CopilotTestRepo {
  readonly copilotUpstream: UpstreamRecord;
  readonly setUpstreamState: (state: unknown) => void;
  readonly getCurrentState: () => unknown;
}

const setupCopilotTest = async (recordOverrides: Partial<UpstreamRecord> = {}): Promise<CopilotTestRepo> => {
  let upstream = buildCopilotUpstream(recordOverrides);
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        upstream = { ...upstream, state: mutate(upstream.state, 1) };
      },
    },
  }));
  clearInProcessCopilotTokenCache();
  return {
    copilotUpstream: upstream,
    setUpstreamState: state => { upstream = { ...upstream, state }; },
    getCurrentState: () => upstream.state,
  };
};

interface CopilotModelFixture {
  readonly id: string;
  readonly capabilitiesType?: string;
  readonly supported_endpoints?: string[];
  readonly reasoningEfforts?: string[];
  readonly maxContextWindowTokens?: number;
}

const copilotModels = (models: CopilotModelFixture[]) => ({
  object: 'list',
  data: models.map(model => ({
    id: model.id,
    name: model.id,
    version: '1',
    supported_endpoints: model.supported_endpoints ?? [],
    capabilities: {
      type: model.capabilitiesType ?? 'chat',
      limits: {
        ...(model.maxContextWindowTokens === undefined ? {} : { max_context_window_tokens: model.maxContextWindowTokens }),
      },
      ...(model.reasoningEfforts === undefined ? {} : { supports: { reasoning_effort: model.reasoningEfforts } }),
    },
  })),
});

const tokenResponse = (): Response => jsonResponse({
  token: 'copilot-access-token',
  expires_at: 4102444800,
  refresh_in: 3600,
  endpoints: { api: 'https://api.individual.githubcopilot.com' },
});

const copilotPreflight = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') return tokenResponse();
  return null;
};

test('Copilot provider exposes the highest-priority non-Claude endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const provider = createCopilotProvider(copilotUpstream);

  await withMockedFetch(request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    if (new URL(request.url).pathname === '/models') {
      return jsonResponse(copilotModels([{ id: 'gpt-dual', supported_endpoints: ['/responses', '/chat/completions', '/v1/messages'] }]));
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const models = await provider.instance.getProvidedModels(directFetcher);
    assertEquals(models.map(model => model.id), ['gpt-dual']);
    assertEquals(models[0]?.endpoints, { openaiResponses: {} });
  });
});

test('Copilot provider projects claude-* chat-listed models onto Anthropic Messages', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const provider = createCopilotProvider(copilotUpstream);

  await withMockedFetch(request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    if (new URL(request.url).pathname === '/models') {
      return jsonResponse(copilotModels([{ id: 'claude-haiku-chat-listed', supported_endpoints: ['/chat/completions'] }]));
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(directFetcher);
    assertEquals(model?.id, 'claude-haiku-chat-listed');
    assertEquals(model?.endpoints, { anthropicMessages: {} });
  });
});

test('per-model provider defaults override an operator flag and leave other models unchanged', async () => {
  const { copilotUpstream } = await setupCopilotTest({ flagOverrides: { 'rewrite-mid-conv-system-to-user': false } });
  const provider = createCopilotProvider(copilotUpstream);

  await withMockedFetch(request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    if (new URL(request.url).pathname === '/models') {
      return jsonResponse(copilotModels([
        { id: 'claude-opus-4.6', supported_endpoints: ['/chat/completions'] },
        { id: 'claude-opus-4.8', supported_endpoints: ['/chat/completions'] },
        { id: 'gpt-test', supported_endpoints: ['/chat/completions'] },
      ]));
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const models = await provider.instance.getProvidedModels(directFetcher);
    assertEquals(models.find(model => model.id === 'claude-opus-4-6')?.enabledFlags.has('rewrite-mid-conv-system-to-user'), true);
    assertEquals(models.find(model => model.id === 'claude-opus-4-8')?.enabledFlags.has('rewrite-mid-conv-system-to-user'), false);
    assertEquals(models.find(model => model.id === 'gpt-test')?.enabledFlags.has('rewrite-mid-conv-system-to-user'), false);
  });
});

test('known models merge into the row as it stands after the catalog fetch', async () => {
  const harness = await setupCopilotTest();

  await withMockedFetch(request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    if (new URL(request.url).pathname === '/models') {
      const current = readCopilotUpstreamState(harness.getCurrentState());
      harness.setUpstreamState({
        ...current,
        quotaSnapshot: { fetchedAt: 1, data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas: {} } },
      } satisfies CopilotUpstreamState);
      return jsonResponse({ object: 'list', data: [{ id: 'm1', supported_endpoints: ['/v1/messages'] }] });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    await createCopilotProvider(harness.copilotUpstream).instance.getProvidedModels(directFetcher);
  });

  const final = readCopilotUpstreamState(harness.getCurrentState());
  assertEquals(Object.keys(final.knownModels?.models ?? {}), ['m1']);
  assertEquals(final.copilotToken !== null, true);
  assertEquals(final.quotaSnapshot?.fetchedAt, 1);
});

test('catalog failures propagate instead of falling back to stored projection', async () => {
  const harness = await setupCopilotTest();
  harness.setUpstreamState({
    knownModels: mergeKnownModels(
      emptyKnownModels(),
      { object: 'list', data: [{ id: 'm-prior', name: 'm-prior', version: '1', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat', limits: {} } }] },
      Date.now(),
    ),
    copilotToken: null,
  });

  await withMockedFetch(request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    if (new URL(request.url).pathname === '/models') return new Response('unavailable', { status: 503 });
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    await assertRejects(() => createCopilotProvider(harness.copilotUpstream).instance.getProvidedModels(directFetcher));
  });
});

test('System One decisions project their target and run through the decision pipeline', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const provider = createCopilotProvider(copilotUpstream);
  let sent: Record<string, unknown> | undefined;

  await withMockedFetch(async request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    const { pathname } = new URL(request.url);
    if (pathname === '/models') {
      return jsonResponse(copilotModels([
        { id: 'microsoft-decision-1', supported_endpoints: ['/v1/systemone'] },
        { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
      ]));
    }
    if (pathname === '/v1/systemone') {
      sent = await request.json() as Record<string, unknown>;
      return jsonResponse({ model: 'microsoft-decision-1', answers: {}, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const decision = (await provider.instance.getProvidedModels(directFetcher)).find(model => model.id === 'microsoft-decision-1');
    if (decision === undefined) throw new Error('missing decision model');
    assertEquals(decision.endpoints, { decision: {} });
    assertEquals(decision.decisionTarget, { protocol: 'typesafe-systemone' });
    const parsed = parseDecisionRequest('typesafe-systemone', {
      model: 'microsoft-decision-1',
      state: 'The API returns 500 on every call.',
      questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } },
    });
    const outcome = await runPipeline(provider.pipelines.decision!, {
      'provider.model': toProviderModelFacts(decision),
      'request.inboundHeaders': [],
      'request.payload': parsed.request,
    }, { services: { fetcherFor: () => testFetcher } });
    assertEquals(outcome.target, { protocol: 'typesafe-systemone' });
    assertEquals(outcome.http.status, 200);
    await readManagedBytes(outcome.http.body);
  });

  assertEquals(sent?.model, 'microsoft-decision-1');
  assertEquals(sent?.state, 'The API returns 500 on every call.');
  assertEquals(sent?.questions, { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } });
});

test('malformed passive quota headers leave the upstream response usable', async () => {
  const harness = await setupCopilotTest();
  const provider = createCopilotProvider(harness.copilotUpstream);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await withMockedFetch(request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    const { pathname } = new URL(request.url);
    if (pathname === '/models') return jsonResponse(copilotModels([{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }]));
    if (pathname === '/chat/completions') {
      return sseResponse('data: [DONE]\n\n', 200, {
        'x-quota-snapshot-premium_interactions': 'ent=-2&ov=0.0&ovPerm=false&rem=0.0&rst=2026-09-01T00%3A00%3A00Z&totRem=0',
      });
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(directFetcher);
    if (model === undefined) throw new Error('missing chat model');
    const outcome = await runPipeline(provider.pipelines.openaiChatCompletions!, {
      'provider.model': toProviderModelFacts(model),
      'request.inboundHeaders': [],
      'request.payload': { messages: [{ role: 'user', content: 'hi' }] },
    }, { services: { fetcherFor: () => testFetcher } });
    assertEquals(outcome.ok, true);
    if (!outcome.ok) throw new Error('expected chat stream');
    for await (const _frame of outcome.events) continue;
  });

  assertEquals(readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot, null);
  warn.mockRestore();
});
