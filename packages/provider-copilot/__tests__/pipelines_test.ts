import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearInProcessCopilotTokenCache } from '../src/auth.ts';
import { createCopilotProvider } from '../src/provider.ts';
import { readCopilotUpstreamState } from '../src/state.ts';
import { createDumpEncoder, runPipeline } from '@floway-dev/pipeline';
import type { RawRunEvent, RunTraceSink } from '@floway-dev/pipeline';
import { createInMemoryImageProcessor, initImageProcessor } from '@floway-dev/platform';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import type { ProviderModel, UpstreamRecord } from '@floway-dev/provider';
import { initProviderRepo } from '@floway-dev/provider';
import { jsonResponse, readJsonRequest, sseResponse, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_copilot_pipeline';
const TOKEN = 'copilot-exchanged-pipeline-token';
const TOKEN_BASE_URL = 'https://api.individual.githubcopilot.com';

interface Fixture {
  readonly record: UpstreamRecord;
  readonly state: { current: unknown };
}

const record = (): UpstreamRecord => ({
  id: UPSTREAM_ID,
  kind: 'copilot',
  name: 'Copilot pipeline test',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-03-15T00:00:00.000Z',
  updatedAt: '2026-03-15T00:00:00.000Z',
  state: null,
  config: {
    githubHost: 'github.com',
    githubToken: 'ghu_pipeline_test',
    user: { id: 1, login: 'tester', name: 'Tester', avatar_url: 'https://example.com/a.png' },
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

const installRepo = (): Fixture => {
  const upstream = record();
  const state = { current: upstream.state };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...upstream, state: state.current, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        state.current = mutate(state.current, 1);
      },
    },
  }));
  clearInProcessCopilotTokenCache();
  return { record: upstream, state };
};

const tokenResponse = (): Response => jsonResponse({
  token: TOKEN,
  expires_at: 4_102_444_800,
  refresh_in: 3600,
  endpoints: { api: TOKEN_BASE_URL },
});

const model = (id: string, rawModels: string[], endpoint: keyof ProviderModel['endpoints'], extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  upstreamModelId: id,
  limits: {},
  kind: 'chat',
  endpoints: { [endpoint]: {} },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  providerData: { rawModels: rawModels.map(rawId => ({ id: rawId, supported_endpoints: [endpointPath(endpoint)] })) },
  enabledFlags: new Set(),
  ...extra,
});

const endpointPath = (endpoint: keyof ProviderModel['endpoints']): string => {
  switch (endpoint) {
  case 'openaiChatCompletions': return '/chat/completions';
  case 'openaiResponses': return '/responses';
  case 'anthropicMessages': return '/v1/messages';
  case 'openaiEmbeddings': return '/embeddings';
  case 'openaiImagesGenerations': return '/v1/images/generations';
  case 'openaiImagesEdits': return '/v1/images/edits';
  case 'decision': return '/v1/decisions';
  default: throw new Error(`Unsupported test endpoint ${endpoint}`);
  }
};

const providerFacts = (source: ProviderModel) => ({ ...source, enabledFlags: [...source.enabledFlags] });

beforeEach(() => {
  initImageProcessor(createInMemoryImageProcessor());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Copilot provider pipelines', () => {
  test('exposes every supported endpoint pipeline and the current instance contract', () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    expect(provider.instance).toBeDefined();
    expect(provider.pipelines).toBeDefined();
    expect(Object.keys(provider.pipelines ?? {}).sort()).toEqual([
      'anthropicMessages',
      'anthropicMessagesCountTokens',
      'decision',
      'openaiChatCompletions',
      'openaiEmbeddings',
      'openaiImagesEdits',
      'openaiImagesGenerations',
      'openaiResponses',
    ]);
  });

  test('streaming pipeline runtime reaches the declared shaping stages in order', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiResponses;
    if (!pipeline) throw new Error('missing responses pipeline');
    const events: RawRunEvent[] = [];
    await withMockedFetch(request => new URL(request.url).pathname === '/copilot_internal/v2/token'
      ? tokenResponse()
      : sseResponse(), async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('gpt-5', ['gpt-5'], 'openaiResponses')),
        'request.payload': { input: [{ type: 'message', role: 'user', content: 'hello' }] },
        'request.action': 'generate',
      }, {
        traceSink: { push: event => events.push(event) },
        services: { fetcherFor: () => testFetcher },
      });
      if (!outcome.ok || outcome.action !== 'generate') throw new Error('expected generated stream');
      for await (const _frame of outcome.events) {
        // Drain so the trace includes the stream end.
      }
    });
    const names = events.filter((event): event is Extract<RawRunEvent, { readonly k: 'enter' }> => event.k === 'enter').map(event => event.name);
    expect(names).toEqual([
      'select-openaiResponses-model',
      'compress-images',
      'fill-empty-namespace-descriptions',
      'strip-service-tier',
      'strip-image-generation',
      'item-id-membrane',
      'abort-on-tool-argument-whitespace',
      'set-vision-header',
      'set-initiator-header',
      'openai-responses.request',
      'copilot.authenticate',
      'up_copilot_pipeline.http',
    ]);
  });

  test('anthropicMessages exposes the declared shaping stages in order', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.anthropicMessages;
    if (!pipeline) throw new Error('missing messages pipeline');
    const events: RawRunEvent[] = [];
    await withMockedFetch(request => new URL(request.url).pathname === '/copilot_internal/v2/token' ? tokenResponse() : sseResponse(), async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'request.anthropicBeta': [],
        'provider.model': providerFacts(model('claude-sonnet-4.5', ['claude-sonnet-4.5'], 'anthropicMessages')),
        'request.payload': {
          max_tokens: 16,
          thinking: { type: 'enabled', budget_tokens: 32 },
          tools: [{ name: 'x', input_schema: { type: 'object', properties: {} }, eager_input_streaming: true }],
          messages: [{ role: 'user', content: 'hello' }],
        },
      }, {
        traceSink: { push: event => events.push(event) },
        services: { fetcherFor: () => testFetcher },
      });
      if (!outcome.ok) throw new Error('expected messages stream');
      for await (const _frame of outcome.events) {
        // Drain the stream to finish observation.
      }
    });
    const names = events.filter((event): event is Extract<RawRunEvent, { readonly k: 'enter' }> => event.k === 'enter').map(event => event.name);
    expect(names).toEqual([
      'handle-speed-fast-gate',
      'select-anthropicMessages-model',
      'detect-claude-code-metadata',
      'rewrite-context-window-error',
      'set-compact-headers',
      'set-claude-agent-headers',
      'set-interaction-id-header',
      'compress-images',
      'handle-speed-fast',
      'promote-thinking-display',
      'apply-top-level-cache-control',
      'strip-cache-control-extensions',
      'strip-eager-input-streaming',
      'set-vision-header',
      'set-initiator-header',
      'normalize-anthropic-beta',
      'anthropic-beta',
      'anthropic-messages.request',
      'copilot.authenticate',
      'up_copilot_pipeline.http',
    ]);
  });

  test('openaiChatCompletions applies cache markers, derived headers, whitespace guard, and quota capture', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiChatCompletions;
    if (!pipeline) throw new Error('missing chat pipeline');
    let wireBody: Record<string, unknown> | undefined;
    let wireHeaders: Headers | undefined;
    const deferred: Promise<unknown>[] = [];

    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      wireBody = await readJsonRequest(request) as Record<string, unknown>;
      wireHeaders = request.headers;
      return sseResponse(
        'data: {"id":"chat","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        200,
        { 'x-quota-snapshot-chat': 'ent=-1&ov=0&ovPerm=false&rem=100&rst=2026-12-01T00%3A00%3A00Z&totRem=-1' },
      );
    }, async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [['x-initiator', 'inbound-will-be-overwritten']],
        'provider.model': providerFacts(model('gpt-5.4', ['gpt-5.4'], 'openaiChatCompletions')),
        'request.payload': {
          messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'hello' },
          ],
        },
      }, { waitUntil: promise => deferred.push(promise), services: { fetcherFor: () => testFetcher } });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('expected chat stream');
      const frames = [];
      for await (const frame of outcome.events) frames.push(frame);
      expect(frames.length).toBeGreaterThan(0);
    });

    await Promise.all(deferred);
    const persisted = readCopilotUpstreamState(fixture.state.current).quotaSnapshot;
    expect(persisted).toMatchObject({ data: { quotas: { chat: { unlimited: true } } } });
    expect(wireBody).toMatchObject({ stream: true, model: 'gpt-5.4' });
    expect((wireBody?.messages as Array<Record<string, unknown>>)[0]?.copilot_cache_control).toEqual({ type: 'ephemeral' });
    expect(wireHeaders?.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(wireHeaders?.get('x-initiator')).toBe('user');
    expect(wireHeaders?.get('x-request-id')).toBe(wireHeaders?.get('x-agent-task-id'));
    expect(wireHeaders?.get('copilot-integration-id')).toBe('vscode-chat');
  });

  test('openaiResponses generate selects the -fast raw model and normalizes item ids after stripping service_tier', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiResponses;
    if (!pipeline) throw new Error('missing responses pipeline');
    let wireBody: Record<string, unknown> | undefined;

    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      wireBody = await readJsonRequest(request) as Record<string, unknown>;
      return sseResponse(
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp","object":"response","model":"gpt-fast","status":"in_progress","output":[],"incomplete_details":null,"error":null}}\n\n'
        + 'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"function_call","id":"fc_raw","call_id":"call_1","name":"lookup","arguments":""}}\n\n'
        + 'data: {"type":"response.function_call_arguments.done","sequence_number":2,"output_index":0,"item_id":"fc_raw","arguments":"{\\"q\\":1}"}\n\n'
        + 'data: {"type":"response.completed","sequence_number":3,"response":{"id":"resp","object":"response","model":"gpt-fast","status":"completed","output":[{"type":"function_call","id":"fc_raw","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":1}"}],"incomplete_details":null,"error":null}}\n\n'
        + 'data: [DONE]\n\n',
      );
    }, async () => {
      const raw = {
        ...model('gpt-5', ['gpt-5', 'gpt-5-fast'], 'openaiResponses'),
        providerData: {
          rawModels: [
            { id: 'gpt-5', supported_endpoints: ['/responses'] },
            { id: 'gpt-5-fast', supported_endpoints: ['/responses'] },
          ],
        },
      };
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(raw),
        'request.payload': { input: [{ type: 'message', role: 'user', content: 'hello' }], service_tier: 'priority' },
        'request.action': 'generate',
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome.action).toBe('generate');
      expect(outcome.ok).toBe(true);
      if (!outcome.ok || outcome.action !== 'generate') throw new Error('expected responses stream');
      const frames = [];
      for await (const frame of outcome.events) frames.push(frame);
      expect(JSON.stringify(frames)).toContain('fc_');
      expect(JSON.stringify(frames)).not.toContain('fc_raw');
    });

    expect(wireBody?.model).toBe('gpt-5-fast');
    expect(wireBody?.stream).toBe(true);
    expect('service_tier' in (wireBody ?? {})).toBe(false);
  });

  test('openaiResponses compact appends the trigger and returns the compacted envelope', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiResponses;
    if (!pipeline) throw new Error('missing responses pipeline');
    let wireBody: Record<string, unknown> | undefined;
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      wireBody = await readJsonRequest(request) as Record<string, unknown>;
      return jsonResponse({
        id: 'resp_compact',
        object: 'response',
        model: 'gpt-5',
        status: 'completed',
        output: [{ type: 'compaction', id: 'cmp_upstream', encrypted_content: 'sealed' }],
        incomplete_details: null,
        error: null,
      });
    }, async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('gpt-5', ['gpt-5'], 'openaiResponses')),
        'request.payload': { input: [{ type: 'message', role: 'user', content: 'summarize' }], service_tier: 'priority' },
        'request.action': 'compact',
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome).toMatchObject({ action: 'compact', ok: true, modelKey: 'gpt-5' });
      if (!outcome.ok || outcome.action !== 'compact') throw new Error('expected compact result');
      expect(outcome.result.object).toBe('response.compaction');
      const compaction = outcome.result.output.find(item => (item as { type: string }).type === 'compaction') as { readonly id?: string } | undefined;
      expect(compaction?.id).toMatch(/^cmp_[0-9a-f]{32}$/);
      expect(compaction?.id).not.toBe('cmp_upstream');
    });
    expect(wireBody?.stream).toBe(false);
    expect((wireBody?.input as Array<{ type: string }>).at(-1)?.type).toBe('compaction_trigger');
    expect('service_tier' in (wireBody ?? {})).toBe(false);
  });

  test('anthropicMessages rejects unsupported fast mode before token exchange or dispatch', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.anthropicMessages;
    if (!pipeline) throw new Error('missing messages pipeline');
    let fetched = false;
    await withMockedFetch(() => {
      fetched = true;
      return tokenResponse();
    }, async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'request.anthropicBeta': [],
        'provider.model': providerFacts(model('claude-sonnet-4.5', ['claude-sonnet-4.5'], 'anthropicMessages')),
        'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], speed: 'fast' },
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome).toMatchObject({ ok: false, modelKey: 'claude-sonnet-4.5' });
      if (outcome.ok) throw new Error('expected gate failure');
      expect(outcome.http.status).toBe(400);
      expect(new TextDecoder().decode(await new Response(outcome.http.body === null ? null : new ReadableStream({
        async start(controller) { for await (const chunk of outcome.http.body!) controller.enqueue(chunk); controller.close(); },
      })).arrayBuffer())).toContain('does not support the `speed` parameter');
    });
    expect(fetched).toBe(false);
  });

  test('anthropicMessages rewrites context-window failures exactly once and does not leak the original body', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.anthropicMessages;
    if (!pipeline) throw new Error('missing messages pipeline');
    await withMockedFetch(request => new URL(request.url).pathname === '/copilot_internal/v2/token'
      ? tokenResponse()
      : new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Request body is too large for model context window' } }), {
          status: 413,
          headers: { 'content-type': 'application/json', 'x-upstream-trace': 'too-large' },
        }), async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'request.anthropicBeta': [],
        'provider.model': providerFacts(model('claude-sonnet-4.5', ['claude-sonnet-4.5'], 'anthropicMessages')),
        'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'large' }] },
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected context failure');
      expect(outcome.http.status).toBe(400);
      expect(outcome.http.headers).toEqual([['content-type', 'application/json']]);
      const text = await new Response(new ReadableStream({
        async start(controller) { for await (const chunk of outcome.http.body!) controller.enqueue(chunk); controller.close(); },
      })).text();
      expect(text).toContain('prompt is too long');
    });
  });

  test('anthropicMessages preserves non-context upstream error status, text, headers, and body', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.anthropicMessages;
    if (!pipeline) throw new Error('missing messages pipeline');
    await withMockedFetch(request => new URL(request.url).pathname === '/copilot_internal/v2/token'
      ? tokenResponse()
      : new Response('upstream unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'content-type': 'text/plain', 'x-upstream-trace': 'trace-503' },
        }), async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'request.anthropicBeta': [],
        'provider.model': providerFacts(model('claude-sonnet-4.5', ['claude-sonnet-4.5'], 'anthropicMessages')),
        'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected upstream error');
      expect(outcome.http.status).toBe(503);
      expect(outcome.http.statusText).toBe('Service Unavailable');
      expect(outcome.http.headers).toContainEqual(['x-upstream-trace', 'trace-503']);
      const text = await new Response(new ReadableStream({
        async start(controller) {
          for await (const chunk of outcome.http.body!) controller.enqueue(chunk);
          controller.close();
        },
      })).text();
      expect(text).toBe('upstream unavailable');
    });
  });

  test('anthropicMessages applies Claude Code identity headers and deletes the integration header sentinel', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.anthropicMessages;
    if (!pipeline) throw new Error('missing messages pipeline');
    let wireHeaders: Headers | undefined;
    await withMockedFetch(request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') return tokenResponse();
      wireHeaders = request.headers;
      return sseResponse();
    }, async () => {
      await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'request.anthropicBeta': [],
        'provider.model': providerFacts(model('claude-sonnet-4.5', ['claude-sonnet-4.5'], 'anthropicMessages')),
        'request.payload': {
          max_tokens: 16,
          metadata: { user_id: 'user_dev-1_account__session_sess-1' },
          messages: [{ role: 'user', content: 'hello' }],
        },
      }, { services: { fetcherFor: () => testFetcher } });
    });
    expect(wireHeaders?.get('x-interaction-type')).toBe('messages-proxy');
    expect(wireHeaders?.get('openai-intent')).toBe('messages-proxy');
    expect(wireHeaders?.get('user-agent')).toContain('vscode_claude_code');
    expect(wireHeaders?.get('copilot-integration-id')).toBeNull();
    expect(wireHeaders?.get('x-interaction-id')).toBe('abe633f3-a47a-4758-974e-abe9160daf36');
  });

  test('anthropicMessagesCountTokens preserves JSON and sends the normalized beta header', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.anthropicMessagesCountTokens;
    if (!pipeline) throw new Error('missing count-tokens pipeline');
    let wireBody: Record<string, unknown> | undefined;
    let wireHeaders: Headers | undefined;
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      wireBody = await readJsonRequest(request) as Record<string, unknown>;
      wireHeaders = request.headers;
      return jsonResponse({ input_tokens: 7 });
    }, async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'request.anthropicBeta': ['unknown-beta', 'interleaved-thinking-2025-05-14', 'context-1m-2025-08-07'],
        'provider.model': providerFacts(model('claude-sonnet-4.5', ['claude-sonnet-4.5'], 'anthropicMessages')),
        'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome.status).toBe(200);
    });
    expect(wireBody).toEqual({ max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], model: 'claude-sonnet-4.5' });
    expect(wireHeaders?.get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14');
  });

  test('openaiChatCompletions aborts a stream that emits excessive tool-argument whitespace', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiChatCompletions;
    if (!pipeline) throw new Error('missing chat pipeline');
    await withMockedFetch(request => new URL(request.url).pathname === '/copilot_internal/v2/token'
      ? tokenResponse()
      : sseResponse(
          'data: {"id":"chat","object":"chat.completion.chunk","created":1,"model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","type":"function","function":{"name":"x","arguments":"\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n\\n"}}]},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
        ), async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('gpt-5', ['gpt-5'], 'openaiChatCompletions')),
        'request.payload': { messages: [{ role: 'user', content: 'call a tool' }] },
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('expected parsed stream');
      await expect(async () => {
        for await (const _frame of outcome.events) {
          // Consume through the guard.
        }
      }).rejects.toThrow('Copilot tool call arguments contained excessive consecutive whitespace');
    });
  });

  test('openaiEmbeddings wraps scalar string input into an array', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiEmbeddings;
    if (!pipeline) throw new Error('missing embeddings pipeline');
    let wireBody: Record<string, unknown> | undefined;
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      wireBody = await readJsonRequest(request) as Record<string, unknown>;
      return jsonResponse({ data: [{ embedding: [0.1] }] });
    }, async () => {
      await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('text-embedding-3-small', ['text-embedding-3-small'], 'openaiEmbeddings', { kind: 'embedding' })),
        'request.payload': { input: 'hello' },
      }, { services: { fetcherFor: () => testFetcher } });
    });
    expect(wireBody).toEqual({ input: ['hello'], model: 'text-embedding-3-small' });
  });

  test('openaiImagesGenerations and openaiImagesEdits use the Copilot v1 image paths', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const seen: Array<{ path: string; contentType: string | null; body: string }> = [];
    await withMockedFetch(async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') return tokenResponse();
      seen.push({ path: url.pathname, contentType: request.headers.get('content-type'), body: await request.text() });
      return jsonResponse({ data: [] });
    }, async () => {
      const generation = provider.pipelines?.openaiImagesGenerations;
      const edits = provider.pipelines?.openaiImagesEdits;
      if (!generation || !edits) throw new Error('missing image pipelines');
      await runPipeline(generation, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('gpt-image-1', ['gpt-image-1'], 'openaiImagesGenerations', { kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } })),
        'request.payload': { prompt: 'a cat' },
      }, { services: { fetcherFor: () => testFetcher } });

      const editModel = model('gpt-image-1', ['gpt-image-1'], 'openaiImagesEdits', { kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });
      await runPipeline(edits, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(editModel),
        'request.payload': {
          images: [{ type: 'upload', bytes: new Uint8Array([1, 2, 3]), filename: 'a.png', contentType: 'image/png' }],
          parameters: { prompt: 'edit' },
        },
      }, { services: { fetcherFor: () => testFetcher } });

      await runPipeline(edits, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(editModel),
        'request.payload': {
          images: [{ type: 'reference', reference: { image_url: 'https://example.com/image.png' } }],
          parameters: { prompt: 'edit remote' },
        },
      }, { services: { fetcherFor: () => testFetcher } });
    });
    expect(seen.map(entry => entry.path)).toEqual(['/v1/images/generations', '/v1/images/edits', '/v1/images/edits']);
    expect(seen[1]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[1]?.body).toContain('filename="a.png"');
    expect(seen[2]?.contentType).toBe('application/json');
    expect(JSON.parse(seen[2]!.body)).toMatchObject({ model: 'gpt-image-1', images: [{ image_url: 'https://example.com/image.png' }] });
  });

  test('decision serializes its target dialect and returns the advertised target', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.decision;
    if (!pipeline) throw new Error('missing decision pipeline');
    const parsed = parseDecisionRequest('openai-decisions', {
      model: 'gpt-6-luna-decisions',
      input: 'The service returns 500.',
      questions: [{ type: 'predicate', name: 'bug', instructions: 'Is this a bug?' }],
    });
    const decisionModel = model('gpt-6-luna-decisions', ['gpt-6-luna-decisions'], 'decision', {
      kind: 'decision',
      decisionTarget: { protocol: 'openai-decisions', path: '/v1/decisions' },
    });
    let wireBody: Record<string, unknown> | undefined;
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      wireBody = await readJsonRequest(request) as Record<string, unknown>;
      return jsonResponse({ answers: [] });
    }, async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(decisionModel),
        'request.payload': parsed.request,
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome.target).toEqual({ protocol: 'openai-decisions', path: '/v1/decisions' });
      expect(outcome.modelKey).toBe('gpt-6-luna-decisions');
    });
    expect(wireBody).toMatchObject({ model: 'gpt-6-luna-decisions', input: 'The service returns 500.' });
  });

  test('token-exchange failures surface as a synthetic HttpOutcome', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiEmbeddings;
    if (!pipeline) throw new Error('missing embeddings pipeline');
    await withMockedFetch(() => new Response('token endpoint denied', {
      status: 403,
      headers: { 'x-request-id': 'token-failure-request' },
    }), async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('text-embedding-3-small', ['text-embedding-3-small'], 'openaiEmbeddings', { kind: 'embedding' })),
        'request.payload': { input: 'hello' },
      }, { services: { fetcherFor: () => testFetcher } });
      expect(outcome).toMatchObject({ status: 403, statusText: '', modelKey: 'text-embedding-3-small' });
      const text = await new Response(new ReadableStream({
        async start(controller) {
          for await (const chunk of outcome.body!) controller.enqueue(chunk);
          controller.close();
        },
      })).text();
      expect(text).toBe('token endpoint denied');
      expect(outcome.headers).toContainEqual(['x-request-id', 'token-failure-request']);
    });
  });

  test('quota snapshot is observed after a successful data-plane response and persisted through waitUntil', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiEmbeddings;
    if (!pipeline) throw new Error('missing embeddings pipeline');
    const pending: Promise<unknown>[] = [];
    await withMockedFetch(request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-quota-snapshot-chat': 'ent=100&ov=0&ovPerm=false&rem=75&rst=2026-12-01T00%3A00%3A00Z&totRem=75',
        },
      });
    }, async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('text-embedding-3-small', ['text-embedding-3-small'], 'openaiEmbeddings', { kind: 'embedding' })),
        'request.payload': { input: 'hello' },
      }, { waitUntil: promise => pending.push(promise), services: { fetcherFor: () => testFetcher } });
      for await (const _chunk of outcome.body ?? []) {
        // Drain the response body before the pipeline scope closes.
      }
    });
    await Promise.all(pending);
    expect(readCopilotUpstreamState(fixture.state.current).quotaSnapshot?.data.quotas.chat).toMatchObject({ percent_remaining: 75, quota_remaining: 75 });
  });

  test('dump encoding with raw-secret detection never leaks the exchanged Copilot bearer token', async () => {
    const fixture = installRepo();
    const provider = createCopilotProvider(fixture.record);
    const pipeline = provider.pipelines?.openaiEmbeddings;
    if (!pipeline) throw new Error('missing embeddings pipeline');
    const encoder = createDumpEncoder({ detectRawSecretLeaks: true });
    const encoded: unknown[] = [];
    const traceSink: RunTraceSink = {
      push: event => encoded.push(...encoder.encodeBatch([event])),
      registerSecretPlaintext: plaintext => encoder.registerSecretPlaintext(plaintext),
    };
    let sawSecret = false;
    await withMockedFetch(async request => {
      if (new URL(request.url).pathname === '/copilot_internal/v2/token') return tokenResponse();
      sawSecret = request.headers.get('authorization') === `Bearer ${TOKEN}`;
      return jsonResponse({ data: [] });
    }, async () => {
      const outcome = await runPipeline(pipeline, {
        'request.inboundHeaders': [],
        'provider.model': providerFacts(model('text-embedding-3-small', ['text-embedding-3-small'], 'openaiEmbeddings', { kind: 'embedding' })),
        'request.payload': { input: 'hello' },
      }, { traceSink, services: { fetcherFor: () => testFetcher } });
      for await (const _chunk of outcome.body ?? []) {
        // Drain before the trace sink is inspected.
      }
    });
    const dump = JSON.stringify(encoded);
    expect(sawSecret).toBe(true);
    expect(dump).not.toContain(TOKEN);
  });
});
