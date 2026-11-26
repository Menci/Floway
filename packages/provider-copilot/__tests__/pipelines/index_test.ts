import { expect, test, vi } from 'vitest';

import type { StageEvent } from './inspect.ts';
import { copilotUpstreamFact, type CopilotUpstream } from '../../src/config.ts';
import { emptyKnownModels, mergeKnownModels } from '../../src/known-models.ts';
import { copilotPipelines } from '../../src/pipelines/index.ts';
import { createCopilotService, type CopilotServices } from '../../src/service.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from '../../src/state.ts';
import { getHeader, UpstreamTransportError, type HttpHeaders, type ProviderFetcher } from '@floway-dev/http';
import { run, Secret, type Facts, type ManagedStream, type Result } from '@floway-dev/pipeline';
import { createInMemoryImageProcessor, initImageProcessor } from '@floway-dev/platform';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import { directFetcher, initProviderRepo, toProviderModelFact, type GatewayFacts, type ProtocolStreamError, type ProviderModel, type ProviderOperation, type ProviderPipelines, type ProviderRequestFacts, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

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
  copilotUpstream: UpstreamRecord;
  setUpstreamState: (state: unknown) => void;
  getCurrentState: () => unknown;
  overrideSaveState: (impl: (id: string, mutate: (current: unknown) => unknown) => Promise<void>) => void;
}

const setupCopilotTest = async (recordOverrides: Partial<UpstreamRecord> = {}): Promise<CopilotTestRepo> => {
  let upstream = buildCopilotUpstream(recordOverrides);
  // Applies the mutator to the row as it stands, the way the repo does.
  let saveStateImpl: (id: string, mutate: (current: unknown) => unknown) => Promise<void> = async (_id, mutate) => {
    const next = mutate(upstream.state);
    upstream = { ...upstream, state: next };
  };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, configVersion: 1 }),
      saveState: (id, mutate) => saveStateImpl(id, current => mutate(current, 1)),
    },
  }));
  initImageProcessor(createInMemoryImageProcessor());
  return {
    copilotUpstream: upstream,
    setUpstreamState: state => { upstream = { ...upstream, state }; },
    getCurrentState: () => upstream.state,
    overrideSaveState: impl => { saveStateImpl = impl; },
  };
};

const providerFetch: ProviderFetcher = async (url, init) => ({ response: await directFetcher(url, init) });
const pipelines: ProviderPipelines<CopilotServices, CopilotUpstream> = copilotPipelines;

const copilotHost = (record: UpstreamRecord, fetcher = providerFetch, copilot = createCopilotService()) => {
  const upstream = copilotUpstreamFact(record);
  const services = { copilot, fetcher: () => fetcher };
  const detached: Promise<unknown>[] = [];
  return {
    models: () => copilot.refreshCatalog(record, fetcher, (message, error) => { throw new Error(message, { cause: error }); }, promise => { detached.push(promise); }),
    detached,
    async invoke<Op extends ProviderOperation>(
      operation: Op,
      model: ProviderModel,
      body: Omit<GatewayFacts[`request.${NoInfer<Op>}`], 'model'>,
      options: { headers?: HttpHeaders; controller?: AbortController } = {},
    ) {
      const pipeline = pipelines[operation];
      if (pipeline === undefined) throw new Error(`Copilot test operation ${operation} has no handle`);
      const key = `request.${operation}` as const;
      const request = {
        'request.http': {
          url: 'https://floway.test',
          method: 'POST',
          headers: options.headers ?? [],
          body: null,
        },
        'provider.model': toProviderModelFact(model),
        'provider.upstream': upstream,
        [key]: operation === 'decision' || operation === 'openaiImagesEdits' ? body : { ...body, model: model.id },
      } as ProviderRequestFacts<Op, CopilotUpstream>;
      const controller = options.controller ?? new AbortController();
      const running = run(pipeline, request, {
        services,
        signal: controller.signal,
        waitUntil: promise => { detached.push(promise); },
      });
      try {
        const answer = await running.result;
        const responseKey = `response.${operation}` as const;
        const outcome = (answer as Facts)[responseKey] as GatewayFacts[typeof responseKey];
        const items: Result<StageEvent<Op>, ProtocolStreamError>[] = [];
        if (outcome.kind === 'stream') {
          for await (const item of running.read(outcome.stream as ManagedStream<StageEvent<Op>, ProtocolStreamError>)) items.push(item);
        }
        await running.done;
        return { http: answer['response.http'], outcome, items, answer };
      } finally {
        controller.abort();
      }
    },
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

test('Copilot provider exposes the highest-priority non-Claude endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);

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
      const models = await host.models();

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
  const host = copilotHost(copilotUpstream);
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
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
      if (url.pathname === '/v1/messages') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await host.models();

      assertEquals(providerModel.id, 'claude-haiku-chat-listed');
      assertEquals(providerModel.endpoints, { anthropicMessages: {} });

      await host.invoke('anthropicMessages', providerModel, {
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      });
    },
  );

  assertEquals(upstreamBody?.model, 'claude-haiku-chat-listed');
});

test('Copilot provider selects raw variants that support the target endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  let openaiResponsesBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
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
              id: 'claude-opus-4.7',
              supported_endpoints: ['/responses'],
              reasoningEfforts: ['medium'],
            },
            {
              id: 'claude-opus-4.7-xhigh',
              supported_endpoints: ['/v1/messages'],
              reasoningEfforts: ['xhigh'],
            },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        openaiResponsesBody = (await request.json()) as Record<string, unknown>;
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await host.models();
      await host.invoke('openaiResponses', providerModel, {
        input: [{
          type: 'additional_tools',
          role: 'developer',
          tools: [{
            type: 'namespace',
            name: 'functions',
            description: '',
            tools: [{ type: 'function', name: 'lookup', description: 'Look up a record.', parameters: { type: 'object', properties: {} } }],
          }],
        }],
        reasoning: { effort: 'xhigh' },
      });
    },
  );

  assertEquals(openaiResponsesBody?.model, 'claude-opus-4.7');
});

test('Copilot runs the shared OpenAI Responses stages through its independent compact handle', async () => {
  // The compact-path boundary registers payload mutators (strip-service-tier,
  // strip-image-generation, ...) plus header derivers (set-vision-header,
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  let openaiResponsesBody: Record<string, unknown> | undefined;
  let visionHeader: string | null = null;
  let initiatorHeader: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-resp', supported_endpoints: ['/responses'] }]));
      }
      if (url.pathname === '/responses') {
        openaiResponsesBody = (await request.json()) as Record<string, unknown>;
        visionHeader = request.headers.get('copilot-vision-request');
        initiatorHeader = request.headers.get('x-initiator');
        return jsonResponse({
          id: 'resp_test',
          object: 'response',
          model: 'gpt-resp',
          status: 'completed',
          output: [{ type: 'compaction', summary: 'compacted state' }],
          incomplete_details: null,
          error: null,
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await host.models();
      // service_tier is set so stripServiceTier has something to strip;
      // an input_image is included so setVisionHeader fires; the last
      // input item is a user message so setInitiatorHeader picks 'user'.
      const result = await host.invoke('openaiResponsesCompact', providerModel, {
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [{
              type: 'namespace',
              name: 'functions',
              description: '',
              tools: [{ type: 'function', name: 'lookup', description: 'Look up a record.', parameters: { type: 'object', properties: {} } }],
            }],
          },
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'compact me' },
              { type: 'input_image', image_url: 'https://example.com/x.png', detail: 'auto' },
            ],
          },
        ],
        service_tier: 'priority',
      });

      if (result.outcome.kind !== 'result') throw new Error('expected compaction result');
      assertEquals(result.outcome.result.object, 'response.compaction');
      assertEquals(result.answer['response.usageModelKey'], openaiResponsesBody?.model);
    },
  );

  if (!openaiResponsesBody) throw new Error('expected /responses to be hit');
  assertEquals('store' in openaiResponsesBody, false);
  assertEquals('service_tier' in openaiResponsesBody, false);
  const wireInput = openaiResponsesBody?.input as Array<{ type: string }>;
  assertEquals(wireInput[0]?.type, 'additional_tools');
  assertEquals(wireInput.at(-1)?.type, 'compaction_trigger');
  assertEquals(visionHeader, 'true');
  assertEquals(initiatorHeader, 'user');
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
  const host = copilotHost(copilotUpstream);

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
      const models = await host.models();
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

test('Copilot provider forces stream=true for streaming endpoints and leaves count-tokens/embeddings alone', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  const bodies: Record<string, Record<string, unknown>> = {};

  await withMockedFetch(
    async request => {
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
            { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
            { id: 'gpt-resp', supported_endpoints: ['/responses'] },
            { id: 'claude-msg', supported_endpoints: ['/v1/messages'] },
            { id: 'emb-mini', supported_endpoints: ['/embeddings'] },
          ]),
        );
      }

      const path = url.pathname;
      bodies[path] = (await request.json()) as Record<string, unknown>;

      if (['/chat/completions', '/responses', '/v1/messages'].includes(path)) {
        return sseResponse();
      }
      if (path === '/v1/messages/count_tokens') {
        return jsonResponse({ input_tokens: 1 });
      }
      if (path === '/embeddings') {
        return jsonResponse({ object: 'list', data: [], model: 'emb-mini' });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await host.models();
      const byId = new Map(models.map(model => [model.id, model]));

      const chat = await host.invoke('openaiChatCompletions', byId.get('gpt-chat')!, { messages: [{ role: 'user', content: 'hi' }] });
      await host.invoke('openaiResponses', byId.get('gpt-resp')!, { input: [] });
      await host.invoke('anthropicMessages', byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      const count = await host.invoke('anthropicMessagesCountTokens', byId.get('claude-msg')!, { messages: [{ role: 'user', content: 'hi' }] });
      const embeddings = await host.invoke('openaiEmbeddings', byId.get('emb-mini')!, { input: 'hi' });
      assertEquals(chat.answer['response.usageModelKey'], bodies['/chat/completions'].model);
      assertEquals(count.answer['response.usageModelKey'], bodies['/v1/messages/count_tokens'].model);
      assertEquals(embeddings.answer['response.usageModelKey'], bodies['/embeddings'].model);
    },
  );

  assertEquals(bodies['/chat/completions'].stream, true);
  assertEquals(bodies['/responses'].stream, true);
  assertEquals(bodies['/v1/messages'].stream, true);
  assertEquals('stream' in bodies['/v1/messages/count_tokens'], false);
  assertEquals('stream' in bodies['/embeddings'], false);
});

const copilotPreflight = (request: Request): Response | null => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  return null;
};

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
      const host = copilotHost(copilotUpstream);
      await host.models();
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
      const host = copilotHost(harness.copilotUpstream);
      await assertRejects(() => host.models());
    },
  );
});

// ---------------------------------------------------------------------------
// Anthropic Fast Mode end-to-end through the Copilot provider.
//
// The catalog merges `claude-opus-4.6` and `claude-opus-4.6-fast` into one
// public id; `speed: "fast"` on the request picks the `-fast` raw variant,
// `withSpeedFast` strips the field from the wire, and the response stream
// gets `usage.speed = 'fast'` stamped before it leaves the provider.
// ---------------------------------------------------------------------------

const sseEvent = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const sseDone = (): string => 'data: [DONE]\n\n';

const anthropicMessagesSseBody = (): string =>
  sseEvent('message_start', {
    type: 'message_start',
    message: {
      container: null, diagnostics: null, stop_details: null,
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-opus-4.6-fast',
      stop_reason: null,
      stop_sequence: null,
      usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 5, output_tokens: 0 },
    },
  })
  + sseEvent('message_delta', {
    type: 'message_delta',
    delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 7 },
  })
  + sseEvent('message_stop', { type: 'message_stop' })
  + sseDone();

const fastModelCatalog = () =>
  copilotModels([
    {
      id: 'claude-opus-4.6',
      display_name: 'Claude Opus 4.6',
      supported_endpoints: ['/v1/messages'],
    },
    {
      id: 'claude-opus-4.6-fast',
      display_name: 'Claude Opus 4.6 (fast)',
      supported_endpoints: ['/v1/messages'],
    },
  ]);

const betaModelCatalog = () => copilotModels([
  { id: 'claude-opus-4.6', supported_endpoints: ['/v1/messages'], maxContextWindowTokens: 200_000 },
  { id: 'claude-opus-4.6-1m', supported_endpoints: ['/v1/messages'], maxContextWindowTokens: 1_000_000 },
]);

const betaIntent = ['context-1m-2025-08-07', 'advanced-tool-use-2025-11-20', 'unknown-beta'];

test('Copilot consumes Anthropic Messages beta intent before serializing its supported wire subset', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  let upstreamModel: unknown;
  let upstreamBeta: string | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(betaModelCatalog());
      }
      if (url.pathname === '/v1/messages') {
        upstreamModel = ((await request.json()) as Record<string, unknown>).model;
        upstreamBeta = request.headers.get('anthropic-beta');
        return sseResponse(anthropicMessagesSseBody());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await host.models();
      const result = await host.invoke(
        'anthropicMessages',
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
        { headers: betaIntent.map(beta => ['anthropic-beta', beta]) },
      );
      assertEquals(result.outcome.kind, 'stream');
    },
  );

  assertEquals(upstreamModel, 'claude-opus-4.6-1m');
  assertEquals(upstreamBeta, 'advanced-tool-use-2025-11-20');
});

test('Copilot provider routes speed=fast to the -fast raw variant and stamps usage.speed on the way out', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  let upstreamBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(fastModelCatalog());
      if (url.pathname === '/v1/messages') {
        upstreamBody = (await request.json()) as Record<string, unknown>;
        return sseResponse(anthropicMessagesSseBody());
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await host.models();
      assertEquals(providerModel.id, 'claude-opus-4-6');

      const result = await host.invoke(
        'anthropicMessages',
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], speed: 'fast' },
      );

      const start = result.items.find(item => item.ok && item.value.type === 'message_start');
      if (!start?.ok || start.value.type !== 'message_start') throw new Error('expected message_start');
      assertEquals(start.value.message.usage.speed, 'fast');
      assertEquals(result.answer['response.usageModelKey'], 'claude-opus-4.6-fast');
      assertEquals(result.answer['response.usageModelKey'], upstreamBody?.model);
      const delta = result.items.find(item => item.ok && item.value.type === 'message_delta');
      if (!delta?.ok || delta.value.type !== 'message_delta') throw new Error('expected message_delta');
      assertEquals('speed' in delta.value.usage!, false);
    },
  );

  assertEquals(upstreamBody?.model, 'claude-opus-4.6-fast');
  if (!upstreamBody) throw new Error('expected /v1/messages to be hit');
  assertEquals('speed' in upstreamBody, false);
});

test('Copilot provider carries the rewritten context-window failure status and headers', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-haiku-4.5', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        return new Response('Request body is too large for model context window', { status: 413, headers: { 'x-upstream': 'test' } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await host.models();
      const result = await host.invoke(
        'anthropicMessages',
        model,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      );

      if (result.outcome.kind !== 'error' || result.http === null) throw new Error('expected rewritten context-window error');
      assertEquals(result.http?.status, 400);
      assertEquals(getHeader(result.http.headers, 'content-type'), 'application/json');
      assertEquals(getHeader(result.http.headers, 'x-upstream'), 'test');
      const body = result.outcome.error as { error: { message: string } };
      assertEquals(body.error.message, PROMPT_TOO_LONG_MESSAGE);
    },
  );
});

test('Copilot provider returns HTTP 400 invalid_request_error when speed=fast hits a model without a -fast variant', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  let anthropicMessagesHit = false;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-haiku-4.5', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.pathname === '/v1/messages') {
        anthropicMessagesHit = true;
        return sseResponse();
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [providerModel] = await host.models();

      const result = await host.invoke(
        'anthropicMessages',
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], speed: 'fast' },
      );

      if (result.outcome.kind !== 'error' || result.http === null) throw new Error('expected Fast Mode preflight error');
      assertEquals(result.outcome.source, 'local');
      expect(Object.hasOwn(result.answer, 'response.usageModelKey')).toBe(false);
      assertEquals(result.http?.status, 400);
      const body = result.outcome.error as { type: string; error: { type: string; message: string } };
      // Byte-identical to the wire string Anthropic emits on real api.anthropic.com
      // for the same failure mode — recorded verbatim from a live response in
      // https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
      assertEquals(body.type, 'error');
      assertEquals(body.error.type, 'invalid_request_error');
      assertEquals(body.error.message, "'claude-haiku-4-5' does not support the `speed` parameter.");
    },
  );

  assertEquals(anthropicMessagesHit, false);
});

interface CopilotModelCapabilityFixture {
  id: string;
  type?: 'chat' | 'image';
  supported_endpoints?: string[];
}

const copilotModelsWithCapabilities = (models: CopilotModelCapabilityFixture[]) => ({
  object: 'list',
  data: models.map(model => ({
    id: model.id,
    name: model.id,
    version: '1',
    supported_endpoints: model.supported_endpoints ?? ['/chat/completions'],
    capabilities: {
      type: model.type ?? 'chat',
      limits: {},
    },
  })),
});

const imageModelCatalog = () => copilotModelsWithCapabilities([
  { id: 'gpt-image-2.5-flare', type: 'image', supported_endpoints: ['/v1/images/generations', '/v1/images/edits'] },
]);

const setupImageModelTest = async () => {
  const { copilotUpstream } = await setupCopilotTest();
  return copilotHost(copilotUpstream);
};

// The regression this guards: `copilotAuthedFetch` used to pin
// `Content-Type: application/json` unconditionally, which made Copilot answer
// a multipart edit with `400 Failed to decode image edit request` before
// reading a single part. A FormData body must reach the runtime untouched so
// it can set its own boundary.
test('Copilot image edits keeps multipart uploads free of a JSON content-type', async () => {
  const host = await setupImageModelTest();
  let captured: { path: string; contentType: string | null; body: string } | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') return jsonResponse(imageModelCatalog());
      captured = {
        path: url.pathname,
        contentType: request.headers.get('content-type'),
        body: await request.text(),
      };
      return jsonResponse({ created: 1, data: [{ b64_json: 'AAAA' }] });
    },
    async () => {
      const [model] = await host.models();
      const file = { bytes: new Uint8Array([0x89, 0x50, 0x4E, 0x47]), name: 'in.png', mediaType: 'image/png' };
      const result = await host.invoke('openaiImagesEdits', model, { images: [{ type: 'upload', file }], parameters: { prompt: 'make it blue' } });
      assertEquals(result.http?.status, 200);
      const usageModel = result.answer['response.usageModelKey'];
      expect(usageModel).toBe('gpt-image-2.5-flare');
      expect(captured?.body).toContain(`name="model"\r\n\r\n${usageModel}`);
    },
  );

  assertEquals(captured?.path, '/v1/images/edits');
  assertEquals(captured?.contentType?.startsWith('multipart/form-data; boundary='), true);
  assertEquals(captured?.body.includes('name="image"'), true);
  assertEquals(captured?.body.includes('name="prompt"'), true);
});

// Copilot reports the seat's entitlement on every data-plane response, so a
// served request is enough to keep the dashboard current — no GitHub REST poll
// and no operator click. The headers arrive with the response head, ahead of
// the SSE body, so a streaming call snapshots at stream start.
test('Copilot provider persists the quota snapshot a data-plane response carries', async () => {
  const harness = await setupCopilotTest();
  const host = copilotHost(harness.copilotUpstream);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tid=x;exp=9999999999',
          expires_at: 9_999_999_999,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        return sseResponse('data: [DONE]\n\n', 200, {
          'x-quota-snapshot-chat': 'ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1',
          'x-quota-snapshot-premium_interactions': 'ent=300&ov=0.0&ovPerm=false&rem=90.0&rst=2026-09-01T00%3A00%3A00Z&totRem=270',
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await host.models();
      await host.invoke('openaiChatCompletions', model, { messages: [{ role: 'user', content: 'hi' }] });
      // The persist is fire-and-forget: on workerd `waitUntil` keeps it alive
      // past the response, and here it settles on the host event loop.
      await vi.waitFor(() => {
        if (readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot === null) {
          throw new Error('quota snapshot not persisted yet');
        }
      });
    },
  );

  const snapshot = readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot;
  assertEquals(snapshot?.data.quotas.premium_interactions.quota_remaining, 270);
  assertEquals(snapshot?.data.quotas.chat.unlimited, true);
  assertEquals(snapshot?.data.reset_at, '2026-09-01T00:00:00Z');
});

test('Copilot provider returns the upstream response when passive quota headers are malformed', async () => {
  const harness = await setupCopilotTest();
  const host = copilotHost(harness.copilotUpstream);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tid=x;exp=9999999999',
          expires_at: 9_999_999_999,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.pathname === '/chat/completions') {
        return sseResponse('data: [DONE]\n\n', 200, {
          'x-quota-snapshot-premium_interactions': 'ent=-2&ov=0.0&ovPerm=false&rem=0.0&rst=2026-09-01T00%3A00%3A00Z&totRem=0',
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await host.models();
      const result = await host.invoke('openaiChatCompletions', model, { messages: [{ role: 'user', content: 'hi' }] });
      assertEquals(result.outcome.kind, 'stream');
    },
  );

  assertEquals(readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot, null);
  warn.mockRestore();
});

test('Copilot provider merges the -fast raw variant and reaches it through service_tier', async () => {
  // `gpt-5.6-sol-fast` is the Fast mode lane of `gpt-5.6-sol`, not a model of
  // its own: it is merged out of the public catalog, and a request naming the
  // lane through `service_tier` is what selects the raw id. The field itself
  // never reaches Copilot, which answers HTTP 400 for any value of it.
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  const sent: Record<string, unknown>[] = [];
  let listed: string[] = [];

  await withMockedFetch(
    async request => {
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
            { id: 'gpt-5.6-sol', supported_endpoints: ['/responses'] },
            { id: 'gpt-5.6-sol-fast', supported_endpoints: ['/responses'] },
            // No `grok-code` sibling, so the `-fast` tail is part of the name.
            { id: 'grok-code-fast', supported_endpoints: ['/responses'] },
          ]),
        );
      }
      if (url.pathname === '/responses') {
        sent.push((await request.json()) as Record<string, unknown>);
        return sseResponse();
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await host.models();
      listed = models.map(model => model.id);
      const sol = models.find(model => model.id === 'gpt-5.6-sol')!;

      await host.invoke('openaiResponses', sol, { input: [] });
      await host.invoke('openaiResponses', sol, { input: [], service_tier: 'priority' });
      await host.invoke('openaiResponses', sol, { input: [], service_tier: 'fast' });
      await host.invoke('openaiResponses', sol, { input: [], service_tier: 'flex' });
    },
  );

  assertEquals(listed, ['gpt-5.6-sol', 'grok-code-fast']);
  assertEquals(sent.map(body => body.model), ['gpt-5.6-sol', 'gpt-5.6-sol-fast', 'gpt-5.6-sol-fast', 'gpt-5.6-sol']);
  assertEquals(sent.every(body => !('service_tier' in body)), true);
});

test('Copilot provider derives decision endpoints and forwards the System One body', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  const sent: Record<string, unknown>[] = [];

  await withMockedFetch(
    async request => {
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
            { id: 'microsoft-decision-1', supported_endpoints: ['/v1/systemone'] },
            { id: 'gpt-chat', supported_endpoints: ['/chat/completions'] },
          ]),
        );
      }
      if (url.pathname === '/v1/systemone') {
        sent.push((await request.json()) as Record<string, unknown>);
        return jsonResponse({
          model: 'microsoft-decision-1',
          answers: { team: { type: 'choice', choice: 'engineering', confidence: 0.99, probabilities: { engineering: 0.99, billing: 0.01 } } },
          usage: { input_tokens: 56, output_tokens: 1 },
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const models = await host.models();
      const decision = models.find(model => model.id === 'microsoft-decision-1')!;
      assertEquals(decision.kind, 'decision');
      assertEquals(decision.endpoints, { decision: {} });
      assertEquals(decision.decisionTarget, { protocol: 'typesafe-systemone' });

      const parsed = parseDecisionRequest('typesafe-systemone', {
        model: 'microsoft-decision-1',
        state: 'The API returns 500 on every call.',
        questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } },
      });
      const result = await host.invoke('decision', decision, parsed.request);
      expect(result.outcome.kind === 'result' && result.outcome.result).toBeInstanceOf(Uint8Array);
      assertEquals(result.http?.status, 200);
      assertEquals(result.answer['response.usageModelKey'], sent[0].model);
    },
  );

  assertEquals(sent.length, 1);
  assertEquals(sent[0].model, 'microsoft-decision-1');
  assertEquals(sent[0].state, 'The API returns 500 on every call.');
  assertEquals(sent[0].questions, { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } });
});

test('Copilot sends an OpenAI Decisions model to /v1/decisions in its own dialect', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream);
  const sent: { path: string; body: Record<string, unknown> }[] = [];

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 't', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'gpt-6-luna-decisions', capabilitiesType: 'decisions', supported_endpoints: ['/v1/decisions'] }]));
      }
      if (url.pathname === '/v1/decisions') {
        sent.push({ path: url.pathname, body: (await request.json()) as Record<string, unknown> });
        return jsonResponse({
          model: 'gpt-6-luna',
          answers: [{ type: 'predicate', name: 'p', probability: 1 }],
          usage: { input_tokens: 158, output_tokens: 0 },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const decision = (await host.models())[0]!;
      const parsed = parseDecisionRequest('openai-decisions', {
        model: 'gpt-6-luna-decisions',
        input: 'The API returns 500 on every call.',
        questions: [{ type: 'predicate', name: 'p', instructions: 'Is this a bug?' }],
      });
      const result = await host.invoke('decision', decision, parsed.request);
      expect(result.outcome.kind === 'result' && result.outcome.result).toBeInstanceOf(Uint8Array);
      assertEquals(result.http?.status, 200);
    },
  );

  assertEquals(sent.length, 1);
  assertEquals(sent[0].path, '/v1/decisions');
  // The wire body is the OpenAI Decisions shape, addressed by the catalog id.
  assertEquals(sent[0].body.model, 'gpt-6-luna-decisions');
  assertEquals(sent[0].body.input, 'The API returns 500 on every call.');
  assertEquals(sent[0].body.questions, [{ type: 'predicate', name: 'p', instructions: 'Is this a bug?' }]);
});

test('uses the token exchange HTTP head and upstream JSON error without dialing Copilot', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const service = createCopilotService();
  const error = { error: { code: 'rate_limit', message: 'token window exhausted' }, detail: [1, 'kept'] };
  const fetcher = vi.fn<ProviderFetcher>(async (url, init) => {
    expect(new URL(url).pathname).toBe('/copilot_internal/v2/token');
    expect(new Headers(init.headers).get('authorization')).toMatch(/^token ghu_/);
    return { response: Response.json(error, { status: 429, headers: { 'retry-after': '5' } }) };
  });
  const result = await copilotHost(copilotUpstream, fetcher, service).invoke('openaiChatCompletions', fakeModel(), { messages: [] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(result.http).toMatchObject({ status: 429, body: null, headers: expect.arrayContaining([['retry-after', '5']]) });
  expect(result.outcome).toEqual({ kind: 'error', source: 'upstream', error });
  expect(Object.hasOwn(result.answer, 'response.usageModelKey')).toBe(false);
});

const fakeCopilot = () => ({
  ...createCopilotService(),
  credentials: async () => ({ ok: true, value: { baseUrl: 'https://copilot.test', token: Secret.from('access-token') } } as const),
});

const fakeModel = (overrides?: Parameters<typeof stubProviderModel>[0]) => stubProviderModel({
  id: 'raw-model',
  upstreamModelId: 'raw-model',
  providerData: {
    rawModels: [{
      id: 'raw-model',
      supported_endpoints: ['/chat/completions', '/responses', '/v1/images/generations', '/v1/images/edits'],
    }],
  },
  ...overrides,
});

const countModel = () => fakeModel({
  providerData: { rawModels: [{ id: 'raw-model', supported_endpoints: ['/v1/messages'] }] },
});

test.each([
  ['native', { input_tokens: 17, extra: true }, { input_tokens: 17, extra: true }],
  ['translated', { total_tokens: 23, extra: true }, { input_tokens: 23, extra: true }],
  ['zero translated count', { total_tokens: 0 }, { input_tokens: 0 }],
  ['missing count', { extra: true }, null],
  ['negative translated count', { total_tokens: -1 }, null],
  ['fractional translated count', { total_tokens: 1.5 }, null],
  ['invalid native count', { input_tokens: null, total_tokens: 23 }, null],
] as const)('handles the %s Copilot Anthropic Messages count_tokens response', async (_label, body, expected) => {
  const { copilotUpstream } = await setupCopilotTest();
  const fetcher = vi.fn<ProviderFetcher>(async url => {
    expect(new URL(url).pathname).toBe('/v1/messages/count_tokens');
    return { response: Response.json(body, { headers: { 'x-upstream': 'copilot' } }) };
  });
  const result = await copilotHost(copilotUpstream, fetcher, fakeCopilot()).invoke('anthropicMessagesCountTokens', countModel(), { messages: [] });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.http).toMatchObject({ status: 200, body: null, headers: expect.arrayContaining([['x-upstream', 'copilot']]) });
  if (expected === null) expect(result.outcome).toMatchObject({ kind: 'error', source: 'upstream' });
  else expect(result.outcome).toEqual({ kind: 'result', result: expected });
});

test.each([
  [204, null, 'result'],
  [205, null, 'result'],
  [200, null, 'error'],
  [200, '', 'error'],
  [200, 'null', 'error'],
  [304, null, 'error'],
] as const)('maps a Copilot count_tokens HTTP %s with body %j to a %s outcome', async (status, body, kind) => {
  const { copilotUpstream } = await setupCopilotTest();
  const fetcher = vi.fn<ProviderFetcher>(async url => {
    expect(new URL(url).pathname).toBe('/v1/messages/count_tokens');
    return { response: new Response(body, { status, statusText: 'Copilot', headers: { 'x-upstream': 'copilot' } }) };
  });
  const result = await copilotHost(copilotUpstream, fetcher, fakeCopilot()).invoke('anthropicMessagesCountTokens', countModel(), { messages: [] });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.http).toMatchObject({
    status,
    statusText: 'Copilot',
    body: null,
    headers: expect.arrayContaining([['x-upstream', 'copilot']]),
  });
  if (kind === 'result') expect(result.outcome).toEqual({ kind, result: null });
  else expect(result.outcome).toMatchObject({ kind, source: 'upstream' });
});

test('omits dispatch identity when the request is aborted before fetching', async () => {
  const controller = new AbortController();
  controller.abort();
  const { copilotUpstream } = await setupCopilotTest();
  const fetcher = vi.fn<ProviderFetcher>(async () => { throw new Error('Already-aborted requests must not fetch'); });
  const host = copilotHost(copilotUpstream, fetcher, fakeCopilot());
  const result = await host.invoke('openaiChatCompletions', fakeModel(), { messages: [] }, { controller });
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.http).toBeNull();
  expect(result.outcome).toMatchObject({ kind: 'error', source: 'local' });
  expect(Object.hasOwn(result.answer, 'response.usageModelKey')).toBe(false);
});

test('omits dispatch identity when the request is cancelled while fetching', async () => {
  const controller = new AbortController();
  const { copilotUpstream } = await setupCopilotTest();
  const fetcher = vi.fn<ProviderFetcher>(async (_url, init) => {
    const signal = init.signal;
    if (!signal) throw new Error('HTTP transport must receive the run signal');
    return await new Promise((_, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
      controller.abort();
    });
  });
  const host = copilotHost(copilotUpstream, fetcher, fakeCopilot());
  const result = await host.invoke('openaiChatCompletions', fakeModel(), { messages: [] }, { controller });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.http).toBeNull();
  expect(result.outcome).toMatchObject({ kind: 'error', source: 'local' });
  expect(Object.hasOwn(result.answer, 'response.usageModelKey')).toBe(false);
});

test('keeps dispatch identity for a transport failure before HTTP headers', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const fetcher = vi.fn<ProviderFetcher>(async () => { throw new UpstreamTransportError(new Error('dial reset')); });
  const host = copilotHost(copilotUpstream, fetcher, fakeCopilot());
  const result = await host.invoke('openaiChatCompletions', fakeModel(), { messages: [] });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(result.http).toBeNull();
  expect(result.outcome).toMatchObject({ kind: 'error', source: 'upstream' });
  expect(result.answer['response.usageModelKey']).toBe('raw-model');
});

test('finishes the run while a quota snapshot write is still pending', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const quotaWrite = Promise.withResolvers<void>();
  const observeQuota = vi.fn(async () => { await quotaWrite.promise; });
  const host = copilotHost(copilotUpstream, async () => ({
    response: sseResponse('data: [DONE]\n\n', 200, { 'x-quota-snapshot-chat': 'ent=100&rem=90&totRem=90' }),
  }), { ...fakeCopilot(), observeQuota });
  try {
    const result = await host.invoke('openaiChatCompletions', fakeModel(), { messages: [] });
    expect(result.outcome.kind).toBe('stream');
    expect(host.detached).toHaveLength(1);
    expect(observeQuota).toHaveBeenCalledWith(copilotUpstream.id, expect.arrayContaining([['x-quota-snapshot-chat', expect.any(String)]]));
  } finally {
    quotaWrite.resolve();
    await Promise.all(host.detached);
  }
});

const chatChunk = (usage: Record<string, unknown>, delta: Record<string, unknown> = {}) => ({
  id: 'chatcmpl_test', model: 'raw-model', object: 'chat.completion.chunk', created: 0,
  choices: [{ index: 0, delta, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, ...usage },
});

test.each([
  ['vendor-deepseek', { thinking: { type: 'disabled' } }, { prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 }, { reasoning_content: 'trace' }],
  ['vendor-kimi', { reasoning_effort: 'none' }, { cached_tokens: 3 }, {}],
  ['vendor-qwen', { enable_thinking: false }, {}, {}],
] as const)('uses the %s Chat Completions normalization only for a flagged model', async (flag, expected, usage, delta) => {
  const { copilotUpstream } = await setupCopilotTest();
  const wire: unknown[] = [];
  const chunk = chatChunk(usage, delta);
  const host = copilotHost(copilotUpstream, async (url, init) => {
    expect(url).toBe('https://copilot.test/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-token');
    expect(new Headers(init.headers).has('x-client-private')).toBe(false);
    wire.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)));
    return { response: sseResponse(`data: ${JSON.stringify(chunk)}\n\n`) };
  }, fakeCopilot());
  const request = { messages: [], reasoning_effort: 'none' as const };
  const plain = await host.invoke('openaiChatCompletions', fakeModel(), request, { headers: [['x-client-private', 'drop']] });
  const flagged = await host.invoke('openaiChatCompletions', fakeModel({ enabledFlags: new Set([flag]) }), request);
  expect(wire[0]).toMatchObject({ reasoning_effort: 'none', model: 'raw-model', stream: true });
  expect(wire[1]).toMatchObject(expected);
  expect(plain.items).toEqual([{ ok: true, value: chunk }]);
  if (flag === 'vendor-qwen') expect(flagged.items).toEqual(plain.items);
  else expect(flagged.items).toMatchObject([{ ok: true, value: { usage: { prompt_tokens_details: { cached_tokens: 3 } } } }]);
  if (flag === 'vendor-deepseek') expect(flagged.items).toMatchObject([{ ok: true, value: { choices: [{ delta: { reasoning_text: 'trace' } }] } }]);
});

test.each([
  ['vendor-deepseek', { thinking: { type: 'disabled' } }],
  ['vendor-qwen', { enable_thinking: false }],
] as const)('uses the %s OpenAI Responses normalization only for a flagged model', async (flag, expected) => {
  const { copilotUpstream } = await setupCopilotTest();
  const wire: unknown[] = [];
  const host = copilotHost(copilotUpstream, async (url, init) => {
    expect(url).toBe('https://copilot.test/responses');
    wire.push(JSON.parse(new TextDecoder().decode(init.body as Uint8Array)));
    const event = { type: 'response.completed', response: { id: 'resp_test', model: 'raw-model', object: 'response', status: 'completed', output: [] } };
    return { response: sseResponse(`data: ${JSON.stringify(event)}\n\n`) };
  }, fakeCopilot());
  const request = { input: [], reasoning: { effort: 'none' as const } };
  const plain = await host.invoke('openaiResponses', fakeModel(), request);
  const flagged = await host.invoke('openaiResponses', fakeModel({ enabledFlags: new Set([flag]) }), request);
  expect(wire[0]).toMatchObject({ reasoning: { effort: 'none' }, model: 'raw-model', stream: true });
  expect(wire[1]).toMatchObject(expected);
  expect(wire[1]).not.toHaveProperty('reasoning');
  expect(plain.items.at(-1)).toMatchObject({ ok: true, value: { type: 'response.completed' } });
  expect(flagged.items).toEqual(plain.items);
});

test('returns a malformed compact trigger result as an upstream error with the actual response head', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  let called = false;
  const host = copilotHost(copilotUpstream, async (url, init) => {
    called = true;
    expect(url).toBe('https://copilot.test/responses');
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toMatchObject({
      model: 'raw-model', stream: false, input: [{ type: 'compaction_trigger' }],
    });
    return { response: Response.json({ object: 'response', output: [{ type: 'compaction', encrypted_content: false }] }) };
  }, fakeCopilot());
  const result = await host.invoke('openaiResponsesCompact', fakeModel(), { input: [] });
  expect(called).toBe(true);
  expect(result.http).toMatchObject({ status: 200, body: null });
  expect(result.outcome).toMatchObject({ kind: 'error', source: 'upstream' });
});

test('selects from the catalog publication that advertised an older candidate', async () => {
  const harness = await setupCopilotTest();
  const rawModelIds: unknown[] = [];
  await withMockedFetch(async request => {
    const preflight = copilotPreflight(request);
    if (preflight !== null) return preflight;
    const path = new URL(request.url).pathname;
    if (path === '/models') return jsonResponse(copilotModels([
      { id: 'gpt-test', supported_endpoints: ['/responses'] },
      { id: 'gpt-test-fast', supported_endpoints: ['/responses'] },
    ]));
    if (path === '/responses') {
      rawModelIds.push((await request.json() as { model: string }).model);
      return sseResponse('data: {"type":"response.completed","response":{"id":"resp_test","status":"completed","output":[]}}\n\n');
    }
    throw new Error(`Unhandled fetch ${request.url}`);
  }, async () => {
    const [published] = await copilotHost(harness.copilotUpstream).models();
    const state = readCopilotUpstreamState(harness.getCurrentState());
    const onlyBase = copilotModels([{ id: 'gpt-test', supported_endpoints: ['/responses'] }]);
    harness.setUpstreamState({ ...state, knownModels: mergeKnownModels(emptyKnownModels(), onlyBase, Date.now()) });
    const freshIsolate = copilotHost(harness.copilotUpstream);
    const outcome = await freshIsolate.invoke('openaiResponses', published, { input: [], service_tier: 'priority' });
    expect(outcome.items.at(-1)).toMatchObject({ ok: true, value: { type: 'response.completed' } });
    expect(outcome.answer['response.usageModelKey']).toBe('gpt-test-fast');
  });
  expect(rawModelIds).toEqual(['gpt-test-fast']);
});

test('schedules quota writes for both the token exchange and the catalog GET', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const observed: string[] = [];
  const host = copilotHost(copilotUpstream, async url => {
    const path = new URL(url).pathname;
    observed.push(path);
    const quota = { 'x-quota-snapshot-chat': 'ent=100&rem=90&totRem=90' };
    if (path === '/copilot_internal/v2/token') return {
      response: Response.json({
        token: 'catalog-credential',
        expires_at: 4_102_444_800,
        endpoints: { api: 'https://copilot.test' },
      }, { headers: quota }),
    };
    if (path === '/models') return { response: Response.json(copilotModels([]), { headers: quota }) };
    throw new Error(`Unhandled fetch ${url}`);
  });
  await host.models();
  expect(observed).toEqual(['/copilot_internal/v2/token', '/models']);
  expect(host.detached).toHaveLength(2);
  await Promise.all(host.detached);
});

test.each([
  ['openaiImagesGenerations', true],
  ['openaiImagesGenerations', false],
  ['openaiImagesEdits', true],
  ['openaiImagesEdits', false],
] as const)('uses the %s request to choose decoding when stream=%s disagrees with the upstream medium', async (operation, stream) => {
  const { copilotUpstream } = await setupCopilotTest();
  const host = copilotHost(copilotUpstream, async url => {
    expect(new URL(url).pathname).toBe(operation === 'openaiImagesEdits' ? '/v1/images/edits' : '/v1/images/generations');
    return { response: stream ? jsonResponse({ data: [] }) : sseResponse('data: {"type":"image_generation.completed"}\n\n') };
  }, fakeCopilot());
  const result = operation === 'openaiImagesEdits'
    ? await host.invoke(operation, fakeModel(), {
        images: [{ type: 'reference', reference: { image_url: 'https://example.test/input.png' } }],
        parameters: { stream },
      })
    : await host.invoke(operation, fakeModel(), { stream, prompt: 'A green bicycle' });
  expect(result.http?.status).toBe(200);
  expect(result.outcome).toMatchObject({ kind: 'error', source: 'upstream' });
  expect(result.answer['response.usageModelKey']).toBe('raw-model');
});
