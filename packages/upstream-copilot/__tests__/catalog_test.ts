import { test } from 'vitest';

import { clearInProcessCopilotTokenCache } from '../src/auth.ts';
import { getCopilotModels, rawModelFor } from '../src/catalog.ts';
import { emptyKnownModels, mergeKnownModels } from '../src/known-models.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from '../src/state.ts';
import { assertEquals, assertRejects, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';
import { directFetcher, initUpstreamRuntimeRepo, type UpstreamRecord } from '@floway-dev/upstream';

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
  copilotUpstream: UpstreamRecord;
  setUpstreamState: (state: unknown) => void;
  getCurrentState: () => unknown;
}

const setupCopilotTest = async (recordOverrides: Partial<UpstreamRecord> = {}): Promise<CopilotTestRepo> => {
  let upstream = buildCopilotUpstream(recordOverrides);
  // Applies the mutator to the row as it stands, the way the repo does.
  const saveStateImpl: (id: string, mutate: (current: unknown) => unknown) => Promise<void> = async (_id, mutate) => {
    const next = mutate(upstream.state);
    upstream = { ...upstream, state: next };
  };
  initUpstreamRuntimeRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, version: 1 }),
      saveState: (id, mutate) => saveStateImpl(id, current => mutate(current, 1)),
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
  id: string;
  display_name?: string;
  capabilitiesType?: string;
  supported_endpoints?: string[];
  reasoningEfforts?: string[];
  maxContextWindowTokens?: number;
  maxPromptTokens?: number;
  maxOutputTokens?: number;
}

const copilotModels = (models: CopilotModelFixture[]) => ({
  object: 'list',
  data: models.map(model => ({
    id: model.id,
    name: model.id,
    ...(model.display_name !== undefined ? { display_name: model.display_name } : {}),
    version: '1',
    supported_endpoints: model.supported_endpoints ?? [],
    capabilities: {
      type: model.capabilitiesType ?? 'chat',
      limits: {
        ...(model.maxContextWindowTokens !== undefined ? { max_context_window_tokens: model.maxContextWindowTokens } : {}),
        ...(model.maxPromptTokens !== undefined ? { max_prompt_tokens: model.maxPromptTokens } : {}),
        ...(model.maxOutputTokens !== undefined ? { max_output_tokens: model.maxOutputTokens } : {}),
      },
      ...(model.reasoningEfforts !== undefined ? { supports: { reasoning_effort: model.reasoningEfforts } } : {}),
    },
  })),
});

const copilotPreflight = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  return null;
};

test('Copilot provider exposes the highest-priority non-Claude endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'gpt-dual',
              supported_endpoints: ['/responses', '/chat/completions', '/v1/messages'],
            },
          ]),
        );
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await getCopilotModels(copilotUpstream, directFetcher);

      assertEquals(
        models.map(model => model.id),
        ['gpt-dual'],
      );
      assertEquals(models[0].endpoints, { openaiResponses: {} });
    },
  );
});

test('Copilot provider owns the claude-* Anthropic Messages capability workaround', async () => {
  const { copilotUpstream } = await setupCopilotTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-haiku-chat-listed',
              supported_endpoints: ['/chat/completions'],
            },
          ]),
        );
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [upstreamModel] = await getCopilotModels(copilotUpstream, directFetcher);

      assertEquals(upstreamModel.id, 'claude-haiku-chat-listed');
      assertEquals(upstreamModel.endpoints, { anthropicMessages: {} });
      assertEquals(rawModelFor(upstreamModel, 'anthropicMessages').id, 'claude-haiku-chat-listed');
    },
  );
});

test('Copilot catalog selects Decision dialects from advertised endpoints', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  await withMockedFetch(request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    if (new URL(request.url).pathname !== '/models') throw new Error(`Unhandled fetch ${request.url}`);
    return jsonResponse(copilotModels([
      { id: 'microsoft-decision-1', supported_endpoints: ['/v1/systemone'] },
      { id: 'gpt-6-luna-decisions', capabilitiesType: 'decisions', supported_endpoints: ['/v1/decisions'] },
    ]));
  }, async () => {
    const models = await getCopilotModels(copilotUpstream, directFetcher);
    assertEquals(models.map(model => [model.id, model.kind, model.endpoints, model.decisionTarget]), [
      ['microsoft-decision-1', 'decision', { decision: {} }, { protocol: 'typesafe-systemone' }],
      ['gpt-6-luna-decisions', 'decision', { decision: {} }, { protocol: 'openai-decisions' }],
    ]);
  });
});

test('per-model provider default beats operator upstream override — Claude < 4.8 keeps the system rewrite even when the upstream flag is off', async () => {
  const { copilotUpstream } = await setupCopilotTest({
    // Operator flipped the upstream-wide flag off. Provider says
    // Claude < 4.8 must keep the system rewrite (its Vertex backend rejects
    // inline `role:'system'`), and the per-model layer sits after the
    // upstream override in the resolve chain, so the provider judgment
    // wins for the affected model while every other model honors the
    // operator setting.
    flagOverrides: { 'rewrite-mid-conv-system-to-user': false },
  });

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([
          { id: 'claude-opus-4.6', supported_endpoints: ['/chat/completions'] },
          { id: 'claude-opus-4.8', supported_endpoints: ['/chat/completions'] },
          { id: 'gpt-test', supported_endpoints: ['/chat/completions'] },
        ]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await getCopilotModels(copilotUpstream, directFetcher);
      const claude46 = models.find(m => m.id === 'claude-opus-4-6');
      const claude48 = models.find(m => m.id === 'claude-opus-4-8');
      const gpt = models.find(m => m.id === 'gpt-test');
      if (!claude46 || !claude48 || !gpt) throw new Error('expected all three models in the emitted catalog');
      // Per-model layer forces the rewrite on for Claude < 4.8, even though
      // the operator upstream override said off.
      assertEquals(claude46.enabledFlags.has('rewrite-mid-conv-system-to-user'), true);
      // No per-model rule for Claude >= 4.8; the operator upstream
      // override wins on this row.
      assertEquals(claude48.enabledFlags.has('rewrite-mid-conv-system-to-user'), false);
      // Non-Claude ids never get a per-model rule; operator setting
      // stands.
      assertEquals(gpt.enabledFlags.has('rewrite-mid-conv-system-to-user'), false);
    },
  );
});

test('Copilot provider merges known-models into the row as it stands after the fetch, not into the pre-fetch snapshot', async () => {
  const harness = await setupCopilotTest();
  const { copilotUpstream } = harness;

  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') {
        // A concurrent quota harvest lands while the catalog fetch is in
        // flight, on top of the token the mint just persisted.
        const current = readCopilotUpstreamState(harness.getCurrentState());
        harness.setUpstreamState({
          ...current,
          quotaSnapshot: { fetchedAt: 1, data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas: {} } },
        } satisfies CopilotUpstreamState);
        return jsonResponse({ object: 'list', data: [{ id: 'm1', supported_endpoints: ['/v1/messages'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {

      await getCopilotModels(copilotUpstream, directFetcher);
    },
  );

  const final = readCopilotUpstreamState(harness.getCurrentState());
  if (!final.knownModels) throw new Error('expected knownModels to be persisted');
  assertEquals(Object.keys(final.knownModels.models), ['m1']);
  if (!final.copilotToken) throw new Error('expected the minted token to survive the known-models write');
  assertEquals(final.quotaSnapshot?.fetchedAt, 1);
});

test('Copilot provider throws when the upstream fetch fails — no in-provider fallback to stored projection', async () => {
  const harness = await setupCopilotTest();
  // Seed prior knownModels so a fallback would have something to return if one
  // existed — proving the provider deliberately re-throws regardless.
  const seeded = mergeKnownModels(
    emptyKnownModels(),
    { object: 'list', data: [{ id: 'm-prior', name: 'm-prior', version: '1', supported_endpoints: ['/v1/messages'], capabilities: { type: 'chat', limits: {} } }] },
    Date.now(),
  );
  harness.setUpstreamState({ knownModels: seeded, copilotToken: null });

  await withMockedFetch(
    request => {
      const pre = copilotPreflight(request);
      if (pre) return pre;
      const url = new URL(request.url);
      if (url.pathname === '/models') return new Response('unavailable', { status: 503 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {

      await assertRejects(() => getCopilotModels(harness.copilotUpstream, directFetcher));
    },
  );
});
