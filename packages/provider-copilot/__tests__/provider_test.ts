import { expect, test, vi } from 'vitest';

import { fakeCopilotWire, invokeAnthropic, invokeModel, invokeResponses, modelInput, runCopilotPipeline, setupCopilotTest } from './pipeline-fixture.ts';
import { emptyKnownModels, mergeKnownModels } from '../src/known-models.ts';
import { copilotPipelines } from '../src/pipelines.ts';
import { createCopilotProvider } from '../src/provider.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from '../src/state.ts';
import { Bytes } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import { directFetcher, UpstreamTransportError } from '@floway-dev/provider';
import { assertEquals, assertRejects, jsonResponse, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

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

test('Copilot rewrites wire headers in place and strips client headers before fetch', async () => {
  const { model, fetcher } = await fakeCopilotWire('/chat/completions', 'gpt-test', () => sseResponse('data: [DONE]\n\n'));
  const facts = modelInput(model, { messages: [] });
  let wireHeaders: HeadersInit | undefined;
  const handle = runCopilotPipeline(copilotPipelines.openaiChatCompletions, {
    ...facts,
    'request.http': {
      ...facts['request.http'],
      headers: [
        ['Content-Type', 'text/plain'],
        ['X-Request-Id', 'spoofed'],
        ['copilot-vision-request', 'true'],
        ['anthropic-beta', 'caller-only'],
        ['cookie', 'not-forwarded'],
      ],
    },
  }, async (url, init) => {
    if (new URL(url).pathname === '/chat/completions') wireHeaders = init.headers;
    return await fetcher(url, init);
  });
  try {
    const outcome = (await handle.result)['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected Copilot Chat Completions events');
    await Array.fromAsync(outcome.events);
    expect(await handle.done).toEqual({ ok: true });
  } finally {
    await handle.done;
  }
  if (!Array.isArray(wireHeaders)) throw new Error('Expected ordered Copilot wire headers');
  expect(wireHeaders.slice(0, 2)).toEqual([
    ['Content-Type', 'application/json'],
    ['X-Request-Id', expect.stringMatching(/^[0-9a-f-]{36}$/)],
  ]);
  expect(wireHeaders.find(([name]) => name === 'x-agent-task-id')?.[1]).toBe(wireHeaders[1][1]);
  expect(wireHeaders.map(([name]) => name.toLowerCase())).not.toEqual(expect.arrayContaining(['copilot-vision-request']));
  expect(new Headers(wireHeaders).has('anthropic-beta')).toBe(false);
  expect(new Headers(wireHeaders).has('cookie')).toBe(false);
});

test('Copilot preserves a non-2xx upstream error and retry headers', async () => {
  const error = { error: { type: 'rate_limit_error', message: 'slow down' } };
  const { model, fetcher } = await fakeCopilotWire('/chat/completions', 'gpt-test', () =>
    Response.json(error, { status: 429, headers: { 'Retry-After': '12' } }));
  const { output, events } = await invokeModel(copilotPipelines.openaiChatCompletions, model, { messages: [] }, fetcher);

  expect(events).toBeUndefined();
  expect(output['response.http']).toMatchObject({ status: 429, exchange: 'upstream', body: null });
  expect(output['response.http'].headers).toContainEqual(['retry-after', '12']);
  expect(output['response.openaiChatCompletions']).toEqual({ kind: 'error', source: 'upstream', error });
});

test('Copilot returns an upstream error value on a data-plane transport failure', async () => {
  const { model, fetcher } = await fakeCopilotWire('/chat/completions', 'gpt-test', () => {
    throw new UpstreamTransportError(new Error('connection lost'));
  });
  const { output } = await invokeModel(copilotPipelines.openaiChatCompletions, model, { messages: [] }, fetcher);

  expect(output['response.http']).toMatchObject({ status: 502, exchange: 'upstream', transportError: { message: 'connection lost' } });
  expect(output['response.openaiChatCompletions']).toEqual({
    kind: 'error', source: 'upstream',
    error: { error: { type: 'upstream_transport_error', message: 'connection lost' } },
  });
});

test('Copilot keeps an invalid successful Messages stream classified as a 502', async () => {
  const { model, fetcher } = await fakeCopilotWire('/v1/messages', 'claude-test', () =>
    new Response('Request body is too large for model context window'));
  const { output } = await invokeAnthropic(copilotPipelines.anthropicMessages, model, { max_tokens: 32, messages: [] }, [], fetcher);

  expect(output['response.http']).toMatchObject({ status: 502, exchange: 'upstream', body: null });
  expect(output['response.anthropicMessages']).toMatchObject({
    kind: 'error', source: 'upstream', error: { error: { type: 'upstream_invalid_stream' } },
  });
});

test.each(['{invalid JSON', '{"output":[]}'])('Copilot rejects invalid trigger compaction responses as values (%s)', async body => {
  const { model, fetcher } = await fakeCopilotWire('/responses', 'gpt-test', () =>
    new Response(body, { headers: { 'content-type': 'application/json' } }));
  const { output } = await invokeResponses(copilotPipelines.openaiResponses, model, { input: [] }, 'compact', fetcher);

  expect(output['response.http']).toMatchObject({ status: 502, exchange: 'upstream', body: null });
  expect(output['response.openaiResponses']).toMatchObject({
    kind: 'error', source: 'upstream', error: { error: { type: 'upstream_invalid_json' } },
  });
});

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
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;

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
      const models = await provider.instance.getProvidedModels(directFetcher);

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
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const [providerModel] = await provider.instance.getProvidedModels(directFetcher);

      assertEquals(providerModel.id, 'claude-haiku-chat-listed');
      assertEquals(providerModel.endpoints, { anthropicMessages: {} });

      await invokeAnthropic(copilotPipelines.anthropicMessages, providerModel, {
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      });
    },
  );

  assertEquals(upstreamBody?.model, 'claude-haiku-chat-listed');
});

test('Copilot provider selects raw variants that support the target endpoint', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const [providerModel] = await provider.instance.getProvidedModels(directFetcher);
      await invokeResponses(copilotPipelines.openaiResponses, providerModel, {
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
      }, 'generate');
    },
  );

  assertEquals(openaiResponsesBody?.model, 'claude-opus-4.7');
});

test('Copilot provider runs the OpenAI Responses boundary chain on the compact path', async () => {
  // The compact-path boundary registers payload mutators (strip-service-tier,
  // strip-image-generation, ...) plus header derivers (set-vision-header,
  // set-initiator-header). Driving callOpenAIResponses with action='compact'
  // through a real upstream stub exercises the integration end-to-end: the
  // payload mutators reach the wire body, the header derivers reach the wire
  // request headers, and the compact-shaped envelope still comes back through
  // `compactionResponse`.
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const [providerModel] = await provider.instance.getProvidedModels(directFetcher);
      // service_tier is set so withServiceTierStripped has something to strip;
      // an input_image is included so withVisionHeaderSet fires; the last
      // input item is a user message so withInitiatorHeaderSet picks 'user'.
      const result = await invokeResponses(copilotPipelines.openaiResponses, providerModel, {
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
      }, 'compact');

      assertEquals(result.output['response.http'].status, 200);
      const outcome = result.output['response.openaiResponses'];
      assertEquals(outcome.kind === 'result' && outcome.result.object, 'response.compaction');
      assertEquals(result.events, undefined);
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
  const instance = createCopilotProvider(copilotUpstream);

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
      const models = await instance.instance.getProvidedModels(directFetcher);
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
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const models = await provider.instance.getProvidedModels(directFetcher);
      const byId = new Map(models.map(model => [model.id, model]));

      await invokeModel(copilotPipelines.openaiChatCompletions, byId.get('gpt-chat')!, { messages: [{ role: 'user', content: 'hi' }] });
      await invokeResponses(copilotPipelines.openaiResponses, byId.get('gpt-resp')!, { input: [] }, 'generate');
      await invokeAnthropic(copilotPipelines.anthropicMessages, byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await invokeAnthropic(copilotPipelines.anthropicMessagesCountTokens, byId.get('claude-msg')!, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      await invokeModel(copilotPipelines.openaiEmbeddings, byId.get('emb-mini')!, { input: 'hi' });
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
      const instance = createCopilotProvider(copilotUpstream);
      await instance.instance.getProvidedModels(directFetcher);
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
      const instance = createCopilotProvider(harness.copilotUpstream);
      await assertRejects(() => instance.instance.getProvidedModels(directFetcher));
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
  const provider = createCopilotProvider(copilotUpstream);
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
      const [providerModel] = await provider.instance.getProvidedModels(directFetcher);
      const result = await invokeAnthropic(
        copilotPipelines.anthropicMessages,
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
        betaIntent,
      );
      assertEquals(result.output['response.modelKey'], 'claude-opus-4.6-1m');
    },
  );

  assertEquals(upstreamModel, 'claude-opus-4.6-1m');
  assertEquals(upstreamBeta, 'advanced-tool-use-2025-11-20');
});

test('Copilot provider routes speed=fast to the -fast raw variant and stamps usage.speed on the way out', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const [providerModel] = await provider.instance.getProvidedModels(directFetcher);
      assertEquals(providerModel.id, 'claude-opus-4-6');

      const result = await invokeAnthropic(
        copilotPipelines.anthropicMessages,
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], speed: 'fast' },
      );

      assertEquals(result.output['response.http'].status, 200);
      if (result.events === undefined) throw new Error('Expected Anthropic Messages events');

      const frames = result.events;

      const messageStart = frames.find(f => f.type === 'event' && f.event.type === 'message_start');
      if (messageStart?.type !== 'event' || messageStart.event.type !== 'message_start') {
        throw new Error('expected message_start frame');
      }
      assertEquals(messageStart.event.message.usage.speed, 'fast');

      const messageDelta = frames.find(f => f.type === 'event' && f.event.type === 'message_delta');
      if (messageDelta?.type !== 'event' || messageDelta.event.type !== 'message_delta') {
        throw new Error('expected message_delta frame');
      }
      assertEquals('speed' in messageDelta.event.usage!, false);

      assertEquals(result.output['response.modelKey'], 'claude-opus-4.6-fast');
    },
  );

  assertEquals(upstreamBody?.model, 'claude-opus-4.6-fast');
  if (!upstreamBody) throw new Error('expected /v1/messages to be hit');
  assertEquals('speed' in upstreamBody, false);
});

test('Copilot provider carries the rewritten context-window failure status and headers', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const provider = createCopilotProvider(copilotUpstream);

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
        return new Response('Request body is too large for model context window', { status: 413 });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const result = await invokeAnthropic(
        copilotPipelines.anthropicMessages,
        model,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      );

      assertEquals(result.events, undefined);
      assertEquals(result.output['response.http'].status, 400);
      assertEquals(result.output['response.http'].headers.find(([name]) => name === 'content-type')?.[1], 'application/json');
      assertEquals(result.output['response.anthropicMessages'], {
        kind: 'error', source: 'upstream',
        error: { type: 'error', error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE } },
      });
    },
  );
});

test('Copilot provider returns HTTP 400 invalid_request_error when speed=fast hits a model without a -fast variant', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const [providerModel] = await provider.instance.getProvidedModels(directFetcher);

      const result = await invokeAnthropic(
        copilotPipelines.anthropicMessages,
        providerModel,
        { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], speed: 'fast' },
      );

      assertEquals(result.events, undefined);
      assertEquals(result.output['response.http'].status, 400);
      // Byte-identical to the wire string Anthropic emits on real api.anthropic.com
      // for the same failure mode — recorded verbatim from a live response in
      // https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
      assertEquals(result.output['response.anthropicMessages'], {
        kind: 'error', source: 'local',
        error: {
          type: 'error',
          error: { type: 'invalid_request_error', message: "'claude-haiku-4-5' does not support the `speed` parameter." },
        },
      });
      assertEquals(result.output['response.modelKey'], providerModel.id);
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
  return createCopilotProvider(copilotUpstream);
};

// Copilot needs the compressor's multipart boundary to decode uploaded edits.
test('Copilot image edits keeps multipart uploads free of a JSON content-type', async () => {
  const provider = await setupImageModelTest();
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
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const bytes = Bytes.adopt(new Uint8Array([0x89, 0x50, 0x4E, 0x47]));
      const result = await invokeModel(copilotPipelines.openaiImagesEdits, model, {
        images: [{ type: 'upload', bytes, filename: 'in.png', contentType: 'image/png' }],
        parameters: { prompt: 'make it blue' },
      });
      assertEquals(result.output['response.http'].status, 200);
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
  const provider = createCopilotProvider(harness.copilotUpstream);

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
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const { trace } = await invokeModel(copilotPipelines.openaiChatCompletions, model, { messages: [{ role: 'user', content: 'hi' }] });
      const quota = trace.find(event => event.k === 'deferred' && event.name === 'copilot-quota');
      if (quota?.k !== 'deferred') throw new Error('Expected a Copilot quota deferred');
      const settlement = trace.find(event => event.k === 'settled' && event.deferredId === quota.deferredId);
      assertEquals(settlement?.k === 'settled' && settlement.ok && settlement.value, { persisted: true });
    },
  );

  const snapshot = readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot;
  assertEquals(snapshot?.data.quotas.premium_interactions.quota_remaining, 270);
  assertEquals(snapshot?.data.quotas.chat.unlimited, true);
  assertEquals(snapshot?.data.reset_at, '2026-09-01T00:00:00Z');
});

test('Copilot provider returns the upstream response when passive quota headers are malformed', async () => {
  const harness = await setupCopilotTest();
  const provider = createCopilotProvider(harness.copilotUpstream);
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
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const result = await invokeModel(copilotPipelines.openaiChatCompletions, model, { messages: [{ role: 'user', content: 'hi' }] });
      assertEquals(result.output['response.http'].status, 200);
      const quota = result.trace.find(event => event.k === 'deferred' && event.name === 'copilot-quota');
      if (quota?.k !== 'deferred') throw new Error('Expected a Copilot quota deferred');
      const settlement = result.trace.find(event => event.k === 'settled' && event.deferredId === quota.deferredId);
      assertEquals(settlement?.k === 'settled' && settlement.ok && (settlement.value as { persisted: boolean }).persisted, false);
    },
  );

  assertEquals(readCopilotUpstreamState(harness.getCurrentState()).quotaSnapshot, null);
  warn.mockRestore();
});

test('Copilot resolves a failed quota write as data and delivers the upstream stream', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = new Error('quota database unavailable');
  const { model, fetcher, repo } = await fakeCopilotWire('/chat/completions', 'gpt-test', () => sseResponse(
    'data: [DONE]\n\n',
    200,
    { 'x-quota-snapshot-chat': 'ent=-1&ov=0.0&ovPerm=false&rem=100.0&rst=2026-09-01T00%3A00%3A00Z&totRem=-1' },
  ));
  repo.overrideSaveState(async (_id, mutate) => {
    const updated = readCopilotUpstreamState(mutate(repo.getCurrentState()));
    if (updated.quotaSnapshot !== null) throw error;
    repo.setUpstreamState(updated);
  });
  try {
    const { output, trace } = await invokeModel(copilotPipelines.openaiChatCompletions, model, { messages: [] }, fetcher);
    assertEquals(output['response.http'].status, 200);
    const quota = trace.find(event => event.k === 'deferred' && event.name === 'copilot-quota');
    if (quota?.k !== 'deferred') throw new Error('Expected a Copilot quota deferred');
    const settlement = trace.find(event => event.k === 'settled' && event.deferredId === quota.deferredId);
    assertEquals(settlement?.k === 'settled' && settlement.ok && settlement.value, {
      persisted: false,
      error: { name: 'Error', message: error.message, stack: error.stack },
    });
    assertEquals(warn.mock.calls, [[`Failed to persist Copilot quota snapshot for ${repo.copilotUpstream.id}:`, error]]);
  } finally {
    warn.mockRestore();
  }
});

test('Copilot provider merges the -fast raw variant and reaches it through service_tier', async () => {
  // `gpt-5.6-sol-fast` is the Fast mode lane of `gpt-5.6-sol`, not a model of
  // its own: it is merged out of the public catalog, and a request naming the
  // lane through `service_tier` is what selects the raw id. The field itself
  // never reaches Copilot, which answers HTTP 400 for any value of it.
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const models = await provider.instance.getProvidedModels(directFetcher);
      listed = models.map(model => model.id);
      const sol = models.find(model => model.id === 'gpt-5.6-sol')!;

      await invokeResponses(copilotPipelines.openaiResponses, sol, { input: [] }, 'generate');
      await invokeResponses(copilotPipelines.openaiResponses, sol, { input: [], service_tier: 'priority' }, 'generate');
      await invokeResponses(copilotPipelines.openaiResponses, sol, { input: [], service_tier: 'fast' }, 'generate');
      await invokeResponses(copilotPipelines.openaiResponses, sol, { input: [], service_tier: 'flex' }, 'generate');
    },
  );

  assertEquals(listed, ['gpt-5.6-sol', 'grok-code-fast']);
  assertEquals(sent.map(body => body.model), ['gpt-5.6-sol', 'gpt-5.6-sol-fast', 'gpt-5.6-sol-fast', 'gpt-5.6-sol']);
  assertEquals(sent.every(body => !('service_tier' in body)), true);
});

test('Copilot provider derives decision endpoints and forwards the System One body', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const instance = createCopilotProvider(copilotUpstream);
  const provider = instance;
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
      const models = await provider.instance.getProvidedModels(directFetcher);
      const decision = models.find(model => model.id === 'microsoft-decision-1')!;
      assertEquals(decision.kind, 'decision');
      assertEquals(decision.endpoints, { decision: {} });
      assertEquals(decision.decisionTarget, { protocol: 'typesafe-systemone' });

      const parsed = parseDecisionRequest('typesafe-systemone', {
        model: 'microsoft-decision-1',
        state: 'The API returns 500 on every call.',
        questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } },
      });
      const result = await invokeModel(copilotPipelines.decision, decision, parsed.request);
      assertEquals(result.output['response.decision'], { kind: 'ok', target: { protocol: 'typesafe-systemone' } });
      assertEquals(result.output['response.http'].status, 200);
    },
  );

  assertEquals(sent.length, 1);
  assertEquals(sent[0].model, 'microsoft-decision-1');
  assertEquals(sent[0].state, 'The API returns 500 on every call.');
  assertEquals(sent[0].questions, { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', engineering: 'Bugs' } } });
});

test('Copilot sends an OpenAI Decisions model to /v1/decisions in its own dialect', async () => {
  const { copilotUpstream } = await setupCopilotTest();
  const provider = createCopilotProvider(copilotUpstream);
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
      const decision = (await provider.instance.getProvidedModels(directFetcher))[0]!;
      const parsed = parseDecisionRequest('openai-decisions', {
        model: 'gpt-6-luna-decisions',
        input: 'The API returns 500 on every call.',
        questions: [{ type: 'predicate', name: 'p', instructions: 'Is this a bug?' }],
      });
      const result = await invokeModel(copilotPipelines.decision, decision, parsed.request);
      assertEquals(result.output['response.decision'], { kind: 'ok', target: { protocol: 'openai-decisions' } });
      assertEquals(result.output['response.http'].status, 200);
    },
  );

  assertEquals(sent.length, 1);
  assertEquals(sent[0].path, '/v1/decisions');
  // The wire body is the OpenAI Decisions shape, addressed by the catalog id.
  assertEquals(sent[0].body.model, 'gpt-6-luna-decisions');
  assertEquals(sent[0].body.input, 'The API returns 500 on every call.');
  assertEquals(sent[0].body.questions, [{ type: 'predicate', name: 'p', instructions: 'Is this a bug?' }]);
});
