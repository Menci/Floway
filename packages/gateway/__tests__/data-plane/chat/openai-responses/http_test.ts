import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS } from './test-policy.ts';
import { missingRequiredCompactionKeys, responseOnlyKeysAdded } from './test-required-resource-keys.ts';
import { initOpenAIResponsesWebSocketUpgradeResolver, openaiResponsesWebSocket } from '../../../../src/data-plane/chat/openai-responses/websocket.ts';
import { DEFAULT_WEB_SEARCH_CONFIG, saveWebSearchConfig } from '../../../../src/data-plane/tools/web-search/config.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../../src/repo/models-cache-contract.ts';
import type { ApiKey, StoredUpstreamRecord, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { seedModelsCache, storedModelsRefreshIdentity } from '../../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { UpstreamTransportError, type ProviderFetcher } from '@floway-dev/http';
import { initFetch } from '@floway-dev/platform';
import { openaiResponsesResultToEvents, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { stubProviderModel } from '@floway-dev/test-utils';

const endpoints = { openaiResponses: {}, openaiImagesGenerations: {}, openaiImagesEdits: {} };
const upstream: StoredUpstreamRecord = {
  id: 'up_test', kind: 'custom', name: 'Custom test upstream', enabled: true, sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  usageRefreshIntervalMinutes: 0, proxyFallbackList: [{ id: 'direct_fetch' }], modelsCache: null,
  modelPrefix: null, hue: 210, disabledPublicModelIds: [], flagOverrides: {}, state: null, configVersion: 1,
  config: { baseUrl: 'https://test.example', apiKey: 'fixture', ingressHeadersRules: [], endpoints },
};

const requests: ProviderFetcher[] = [];
const queuedFetch: ProviderFetcher = async (url, init) => {
  const fetch = requests.shift();
  if (!fetch) throw new Error(`Unexpected upstream call to ${url}`);
  return await fetch(url, init);
};

const { openaiResponsesHttp } = await import('../../../../src/data-plane/chat/openai-responses/http.ts');

const apiKey: ApiKey = {
  id: 'key_http_test', name: 'Responses HTTP tests', key: 'fixture', userId: 1,
  serverSecret: '00'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null, upstreamIds: null,
  randomizeUpstreams: false, dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
};
const user: User = {
  id: 1, username: 'http_test', passwordHash: null, createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null, isAdmin: true,
};

const makeApp = () => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', apiKey);
    c.set('user', user);
    await next();
  });
  app.post('/v1/responses', openaiResponsesHttp.generate);
  app.post('/v1/responses/compact', openaiResponsesHttp.compact);
  app.get('/v1/responses', openaiResponsesWebSocket);
  return app;
};

let repo: InMemoryRepo;
beforeEach(async () => {
  requests.length = 0;
  repo = new InMemoryRepo();
  initRepo(repo);
  initFetch(async (url, init) => (await queuedFetch(url, init)).response, new Map(), queuedFetch);
  await saveUpstreamForTest(repo.upstreams, upstream);
  const identity = await storedModelsRefreshIdentity(repo.upstreams, upstream.id);
  expect(await seedModelsCache(repo.upstreams, upstream.id, identity, {
    revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(),
    models: [
      stubProviderModel({
        id: 'test-model', upstreamModelId: 'test-model', endpoints: { openaiResponses: {} },
        enabledFlags: new Set(['openai-responses-image-generation-shim', 'openai-responses-web-search-shim']),
      }),
      stubProviderModel({
        id: 'summary-model', upstreamModelId: 'summary-model', endpoints: { openaiResponses: {} },
        enabledFlags: new Set(['openai-responses-compact-shim']),
      }),
      stubProviderModel({
        id: 'flagged-compact', upstreamModelId: 'flagged-compact', endpoints: { openaiResponses: {} },
        enabledFlags: new Set([
          'openai-responses-agent-message-shim', 'openai-responses-standalone-tool-output-shim',
          'openai-responses-collaboration-shim', 'openai-responses-web-search-shim',
        ]),
      }),
      stubProviderModel({
        id: 'gpt-image-2', upstreamModelId: 'gpt-image-2', kind: 'image',
        endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} },
      }),
    ],
  })).toBe(true);
  await repo.apiKeys.save(apiKey);
  await repo.users.save(user);
});

const post = (body: Record<string, unknown>, path = '/v1/responses') => makeApp().request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'test-model', input: 'hello', ...body }),
});

const sample = (id = 'resp_upstream'): OpenAIResponsesResultEx => ({
  id, object: 'response', model: 'test-model', status: 'completed', error: null, incomplete_details: null,
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
});

const queueSse = (inspect?: (request: Record<string, unknown>) => void, result = sample()): void => {
  requests.push(async (url, init) => {
    expect(new URL(url).pathname).toMatch(/\/responses$/);
    if (inspect) inspect(await new Request(url, init as RequestInit).json() as Record<string, unknown>);
    const body = `${openaiResponsesResultToEvents(result).map(({ event }) =>
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')  }data: [DONE]\n\n`;
    return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) };
  });
};

test('a later HTTP turn restores Responses Lite input positions and metadata', async () => {
  const input = [
    { type: 'additional_tools', role: 'developer', id: 'at_lite', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }] },
    { type: 'message', role: 'developer', id: 'msg_base', content: [{ type: 'input_text', text: 'Caller base instructions' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
    { type: 'message', role: 'user', content: 'First turn' },
  ];
  const bodies: Record<string, unknown>[] = [];
  queueSse(body => bodies.push(body));
  queueSse(body => bodies.push(body));
  const first = await post({ input, store: true });
  expect(first.status).toBe(200);
  const { id } = await first.json() as { id: string };
  const second = await post({ previous_response_id: id, input: 'Second turn', store: true });
  expect(second.status).toBe(200);
  await second.json();

  expect(bodies[0]?.input).toEqual(input);
  expect((bodies[1]?.input as unknown[]).slice(0, input.length)).toEqual(input);
  expect(bodies[1]?.input).toContainEqual({ type: 'message', role: 'user', content: 'Second turn' });
  expect(bodies[1]?.tools).toBeUndefined();
  expect(bodies[1]?.instructions).toBeUndefined();
});

test('streaming Responses wraps the client resource and ends with one success marker', async () => {
  queueSse();
  const response = await post({ stream: true });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  expect(response.headers.get('x-reasoning-included')).toBe('true');
  const body = await response.text();
  expect(body).toContain('event: response.completed');
  expect(body).not.toContain('resp_upstream');
  expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
  expect(body.endsWith('data: [DONE]\n\n')).toBe(true);
});

test('JSON Responses escapes a snapshot persistence panic with its original diagnostics', async () => {
  const fail = vi.spyOn(repo.openaiResponsesSnapshots, 'insert').mockRejectedValue(new Error('simulated snapshot persistence failure'));
  try {
    queueSse();
    const response = await post({ store: true });
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('simulated snapshot persistence failure');
  } finally {
    fail.mockRestore();
  }
});

test('SSE Responses rejects the live read when item persistence panics', async () => {
  const fail = vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
  try {
    queueSse();
    const response = await post({ store: true, stream: true });
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
  } finally {
    fail.mockRestore();
  }
});

const compact = async (usage: OpenAIResponsesResultEx['usage']) => {
  const upstreamResult: OpenAIResponsesResultEx = {
    ...sample(), object: 'response.compaction', output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'ENC' }],
    ...(usage === undefined ? {} : { usage }),
  };
  requests.push(async (url, init) => {
    expect(new URL(url).pathname).toMatch(/\/responses\/compact$/);
    const body = await new Request(url, init as RequestInit).json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('store');
    expect(body).not.toHaveProperty('stream');
    expect(body).not.toHaveProperty('temperature');
    return { response: Response.json(upstreamResult) };
  });
  return { upstreamResult, response: await post({ store: false, stream: true, temperature: 0.3 }, '/v1/responses/compact') };
};

test('compact gives the client a scalar compaction resource with usage', async () => {
  const { upstreamResult, response } = await compact({ input_tokens: 12, output_tokens: 3, total_tokens: 15 });
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect(missingRequiredCompactionKeys(body)).toEqual([]);
  expect(body.usage).toEqual({
    input_tokens: 12, output_tokens: 3, total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });
  expect(responseOnlyKeysAdded(upstreamResult, body)).toEqual([]);
});

test('compact rejects an upstream body with missing usage', async () => {
  const { response } = await compact(null);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    error: { type: 'internal_error', message: expect.stringContaining('no token usage') },
  });
});

test('compact enters generation twice when its first summarization turn returns no assistant text', async () => {
  const outbound: Record<string, unknown>[] = [];
  queueSse(request => outbound.push(request), { ...sample(), model: 'summary-model', output: [] });
  queueSse(request => outbound.push(request), { ...sample(), model: 'summary-model' });
  const tools = [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }];
  const toolChoice = { type: 'function', name: 'lookup' };
  const response = await post({
    model: 'summary-model', store: false, instructions: 'Keep the earlier lookup results',
    tools, tool_choice: toolChoice,
  }, '/v1/responses/compact');
  expect(response.status).toBe(200);
  expect(outbound).toHaveLength(2);
  for (const request of outbound) {
    expect(request).toMatchObject({ tools, tool_choice: toolChoice, instructions: 'Keep the earlier lookup results' });
  }
  expect(outbound[0]?.input).toMatchObject([
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'user' },
  ]);
  expect(outbound[1]?.input).toMatchObject([
    { type: 'message', role: 'system' },
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'user' },
  ]);
  expect(await response.json()).toMatchObject({
    object: 'response.compaction', output: expect.arrayContaining([expect.objectContaining({ type: 'compaction' })]),
    usage: { input_tokens: 24, output_tokens: 6, total_tokens: 30 },
  });
});

test('native compact applies candidate input rewrites before projecting the compact wire', async () => {
  const response = {
    ...sample(), object: 'response.compaction',
    output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' }],
  };
  let wire: Record<string, unknown> | undefined;
  requests.push(async (url, init) => {
    expect(new URL(url).pathname).toMatch(/\/responses\/compact$/);
    wire = await new Request(url, init as RequestInit).json() as Record<string, unknown>;
    return { response: Response.json(response) };
  });
  const result = await post({
    model: 'flagged-compact', store: false,
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'lookup' },
    input: [
      { type: 'agent_message', author: 'sender', recipient: 'receiver', content: [{ type: 'input_text', text: 'message' }] },
      { type: 'function_call_output', name: 'goal_objective', output: 'objective' },
      { type: 'function_call', namespace: 'collaboration', name: 'send_message', call_id: 'call_collab', arguments: '{}' },
      { type: 'web_search_call', id: 'ws_test', action: { type: 'search', query: 'example' } },
    ],
  }, '/v1/responses/compact');
  expect(result.status).toBe(200);
  expect(wire).not.toHaveProperty('tools');
  expect(wire).not.toHaveProperty('tool_choice');
  expect(wire?.input).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'message', content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('sender') })]) }),
    expect.objectContaining({ type: 'message', content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('<external_goal_objective>objective') })]) }),
    expect.objectContaining({ type: 'function_call', call_id: 'call_collab', namespace: 'collaboration-optimize' }),
    expect.objectContaining({ type: 'function_call_output', output: expect.stringContaining('not preserved') }),
  ]));
});

test.each([
  ['invalid JSON', 'returned malformed JSON:'],
  ['{"metadata":[]}', 'must include an output string'],
])('hosted Alpha Search turns invalid success bytes into a final stream error: %s', async (body, diagnostic) => {
  await saveWebSearchConfig({
    ...DEFAULT_WEB_SEARCH_CONFIG,
    passthroughOpenAiSearch: { enabled: true, upstreamId: upstream.id, model: 'test-model' },
  });
  queueSse(undefined, {
    ...sample(), output: [{
      type: 'function_call', id: 'fc_search', call_id: 'call_search', name: 'web_search',
      arguments: '{"search_query":[{"q":"fixture"}]}', status: 'completed',
    }],
  });
  requests.push(async url => {
    expect(new URL(url).pathname).toMatch(/\/alpha\/search$/);
    return { response: new Response(body) };
  });
  const response = await post({ stream: true, store: false, tools: [{ type: 'web_search' }] });
  expect(response.status).toBe(200);
  const output = await response.text();
  expect(output).toContain(diagnostic);
  expect(output).toContain('event: response.failed');
  expect(output).not.toContain('[DONE]');
  expect(requests).toHaveLength(0);
});

test('hosted Alpha Search turns valid upstream bytes into tool output and resumes generation', async () => {
  await saveWebSearchConfig({
    ...DEFAULT_WEB_SEARCH_CONFIG,
    passthroughOpenAiSearch: { enabled: true, upstreamId: upstream.id, model: 'test-model' },
  });
  const remoteOutput = 'Verified Alpha Search output';
  queueSse(undefined, {
    ...sample(), output: [{
      type: 'function_call', id: 'fc_search', call_id: 'call_search', name: 'web_search',
      arguments: '{"search_query":[{"q":"fixture"}]}', status: 'completed',
    }],
  });
  requests.push(async url => {
    expect(new URL(url).pathname).toMatch(/\/alpha\/search$/);
    return { response: new Response(new TextEncoder().encode(JSON.stringify({ output: remoteOutput }))) };
  });
  let continuation: unknown;
  queueSse(request => { continuation = request.input; });
  const response = await post({
    stream: true, store: false, tools: [{ type: 'web_search' }], include: ['web_search_call.results'],
  });
  expect(response.status).toBe(200);
  const output = await response.text();
  expect(output).toContain('event: response.web_search_call.completed');
  expect(output).toContain(remoteOutput);
  expect(output).toContain('event: response.completed');
  expect(continuation).toContainEqual(expect.objectContaining({
    type: 'function_call_output', call_id: 'call_search', output: expect.stringContaining(remoteOutput),
  }));
  expect(requests).toHaveLength(0);
});

test('upstream HTTP errors retain their status, retry hint, and parsed JSON', async () => {
  const error = { error: { code: 'rate_limit_exceeded', message: 'Upstream quota exceeded' }, diagnostic: 'fixture' };
  requests.push(async () => ({
    response: Response.json(error, { status: 429, headers: { 'retry-after': '7' } }),
  }));
  const response = await post({ stream: true });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('7');
  expect(await response.json()).toEqual(error);
});

test('a late transport failure after response.completed prevents the client snapshot from committing', async () => {
  const pendingFailure = Promise.withResolvers<void>();
  const tailRead = Promise.withResolvers<void>();
  const persist = vi.spyOn(repo.openaiResponsesSnapshots, 'insert');
  const frames = openaiResponsesResultToEvents(sample()).map(({ event }) =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  requests.push(async () => {
    let sent = false;
    return {
      response: new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(new TextEncoder().encode(frames));
            return;
          }
          tailRead.resolve();
          await pendingFailure.promise;
          controller.error(new UpstreamTransportError('upstream socket closed before native done'));
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    };
  });
  try {
    const pending = post({ store: true });
    await tailRead.promise;
    expect(persist).not.toHaveBeenCalled();
    pendingFailure.resolve();
    const response = await pending;
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('upstream socket closed before native done');
    expect(persist).not.toHaveBeenCalled();
  } finally {
    pendingFailure.resolve();
    persist.mockRestore();
  }
});

test('Responses renders native stream failure once and omits the success marker', async () => {
  const failure = { code: 'rate_limit_exceeded', message: 'Upstream quota exceeded' };
  const events = [
    { type: 'response.created', response: { ...sample(), status: 'in_progress', output: [] } },
    { type: 'error', ...failure },
    { type: 'response.failed', response: { ...sample(), status: 'failed', output: [], error: failure } },
  ];
  requests.push(async () => ({
    response: new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    }),
  }));
  const response = await post({ stream: true });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body.match(/event: error/g)).toHaveLength(1);
  expect(body.match(/event: response.failed/g)).toHaveLength(1);
  expect(body).toContain(failure.message);
  expect(body).not.toContain('resp_upstream');
  expect(body).not.toContain('[DONE]');
});

test('hosted images retry 429, relay previews, and replay the tool output into generation', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=';
  queueSse(request => {
    expect(request.tools).toContainEqual(expect.objectContaining({ type: 'function', name: 'image_generation' }));
  }, {
    ...sample(), output: [{
      type: 'function_call', id: 'fc_image', call_id: 'call_image', name: 'image_generation', arguments: '{"prompt":"A small circle"}', status: 'completed',
    }],
  });
  let imageAttempts = 0;
  requests.push(async () => {
    imageAttempts++;
    return { response: Response.json({ error: { message: 'rate limited' } }, { status: 429, headers: { 'retry-after-ms': '1' } }) };
  });
  requests.push(async (url, init) => {
    imageAttempts++;
    expect(new URL(url).pathname).toMatch(/\/images\/generations$/);
    expect(await new Request(url, init as RequestInit).json()).toMatchObject({
      prompt: 'A small circle', model: 'gpt-image-2', partial_images: 1, stream: true,
    });
    const body = [
      { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: image },
      { type: 'image_generation.completed', b64_json: image },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  queueSse(request => {
    expect(request.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_image' }));
  });

  const response = await post({ stream: true, store: false, tools: [{ type: 'image_generation', partial_images: 1 }] });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain('event: response.image_generation_call.partial_image');
  expect(body).toContain('event: response.image_generation_call.completed');
  expect(body).toContain('event: response.completed');
  expect(imageAttempts).toBe(2);
  expect(requests).toHaveLength(0);
});

test('a WebSocket interrupt aborts its upstream turn and preserves completed items for another turn', async () => {
  type Handlers = Parameters<Parameters<typeof initOpenAIResponsesWebSocketUpgradeResolver>[0]>[1];
  const upgraded = Promise.withResolvers<Handlers>();
  const aborted = Promise.withResolvers<unknown>();
  const messages: Record<string, unknown>[] = [];
  const socket = { readyState: 1, send(text: string) { messages.push(JSON.parse(text) as Record<string, unknown>); } };
  initOpenAIResponsesWebSocketUpgradeResolver((_context, handlers) => {
    upgraded.resolve(handlers);
    return new Response();
  });
  await makeApp().request('/v1/responses', { headers: { upgrade: 'websocket' } });
  const { onMessage, onClose } = await upgraded.promise;
  const send = (payload: unknown) => onMessage({ data: JSON.stringify(payload) }, socket);

  requests.push(async (_url, init) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const complete = sample().output[0];
        for (const event of [
          { type: 'response.created', response: { ...sample(), status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: complete },
          { type: 'response.output_item.done', output_index: 0, item: complete },
          { type: 'response.output_item.added', output_index: 1, item: { ...complete, id: 'msg_partial', content: [] } },
        ]) controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        if (!init.signal) throw new Error('Expected upstream cancellation signal');
        init.signal.addEventListener('abort', () => {
          aborted.resolve(init.signal?.reason);
          controller.error(init.signal?.reason);
        }, { once: true });
      },
    });
    return { response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }) };
  });

  try {
    send({ type: 'response.create', model: 'test-model', input: 'first', store: false });
    await vi.waitFor(() => {
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'response.output_item.added', item: expect.objectContaining({ id: 'msg_partial' }),
      }));
    });
    const created = messages.find(message => message.type === 'response.created');
    const responseId = (created?.response as { id: string }).id;
    send({ type: 'response.interrupt', response_id: responseId, mode: 'discard_partial_items' });
    await expect(aborted.promise).resolves.toMatchObject({ cause: { message: 'Responses generation interrupted by the client.' } });
    await vi.waitFor(() => {
      expect(messages).toContainEqual(expect.objectContaining({
        type: 'response.incomplete',
        response: expect.objectContaining({
          id: responseId,
          incomplete_details: { reason: 'interrupted' },
          output: expect.arrayContaining([expect.objectContaining({ id: 'msg_1' })]),
        }),
      }));
    });
    const interrupted = messages.find(message => message.type === 'response.incomplete');
    expect((interrupted?.response as { output: unknown[] }).output).not.toContainEqual(expect.objectContaining({ id: 'msg_partial' }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'response.output_item.interrupted', item_id: 'msg_partial' }));
    queueSse(request => {
      expect(request.input).toContainEqual(expect.objectContaining({ id: 'msg_1' }));
      expect(request.input).not.toContainEqual(expect.objectContaining({ id: 'msg_partial' }));
    });
    send({ type: 'response.create', model: 'test-model', input: 'continue', store: false, previous_response_id: responseId });
    await vi.waitFor(() => {
      expect(messages).toContainEqual(expect.objectContaining({ type: 'response.completed' }));
    });
    expect(requests).toHaveLength(0);
  } finally {
    onClose(undefined, socket);
  }
});
