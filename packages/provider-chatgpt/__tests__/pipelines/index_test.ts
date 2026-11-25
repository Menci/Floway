import { assert, beforeEach, expect, test, vi } from 'vitest';

import { CHATGPT_OAUTH_TOKEN_URL, CHATGPT_ORIGINATOR, CHATGPT_RESPONSES_LITE_HEADER } from '../../src/constants.ts';
import { chatgptPipelines } from '../../src/pipelines/index.ts';
import * as responsesLite from '../../src/responses-lite.ts';
import { createChatGPTService, type ChatGPTServices } from '../../src/service.ts';
import type { ChatGPTAccountCredential, ChatGPTUpstreamState } from '../../src/state.ts';
import { chatgptUpstreamFact } from '../../src/upstream-fact.ts';
import { createUpstreamStateRepoStub } from '../upstream-state-repo.ts';
import { getHeader, getHeaders, type HttpRequestFact } from '@floway-dev/http';
import { move, run, Secret } from '@floway-dev/pipeline';
import { initProviderRepo, toProviderModelFact, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const config = { accounts: [{ email: null, chatgptAccountId: 'acct', chatgptUserId: null, planType: 'plus' }] };
const credential = (): ChatGPTAccountCredential => ({
  chatgptAccountId: 'acct', refresh_token: 'refresh-old', state: 'active', state_updated_at: '2026-01-01T00:00:00Z',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555', quotaSnapshot: null,
  accessToken: { token: 'access-old', expiresAt: Date.now() + 3_600_000, refreshedAt: '2026-01-01T00:00:00Z' },
});
let state: ChatGPTUpstreamState = { accounts: [credential()] };
const account = () => state.accounts[0];
const record = (): UpstreamRecord => ({
  id: 'chatgpt', kind: 'chatgpt', name: 'ChatGPT', config, state, enabled: true, usageRefreshIntervalMinutes: 0,
  sortOrder: 0, createdAt: '', updatedAt: '', flagOverrides: {}, disabledPublicModelIds: [],
  proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210,
});
const upstream = move(chatgptUpstreamFact(record()));
const request = move<HttpRequestFact>({
  method: 'POST', url: 'https://floway.test/', body: null,
  headers: [['authorization', Secret.from('Bearer client')], ['originator', 'client-origin'], ['session_id', 'client-session'],
    ['x-codex-image-turn-id', 'image-turn'], ['x-client-request-id', 'client-request'], ['x-extra', 'stripped']],
});
const model = move(toProviderModelFact(stubProviderModel({ id: 'public-model', upstreamModelId: 'wire-model' })));
const entry = { 'request.http': request, 'provider.upstream': upstream, 'provider.model': model };

beforeEach(() => {
  state = { accounts: [credential()] };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: createUpstreamStateRepoStub(record, next => { state = next as ChatGPTUpstreamState; }),
  }));
});

const service = (respond: (url: string, init: Parameters<ReturnType<ChatGPTServices['fetcher']>>[1]) => Response) => {
  const fetcher = vi.fn<ReturnType<ChatGPTServices['fetcher']>>(async (url, init) => ({ ok: true, value: respond(url, init) }));
  return { services: { fetcher: () => fetcher, chatgpt: createChatGPTService() }, fetcher };
};

const terminal = { id: 'resp', object: 'response', model: 'wire-model', status: 'completed', output: [] };
const nativeItem = { type: 'compaction', id: 'compacted', encrypted_content: 'opaque' };
const sse = (...events: ReadonlyArray<Record<string, unknown> & { type: string }>) =>
  events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

test('only exposes the five implemented operations', () => {
  expect(Object.keys(chatgptPipelines).sort()).toEqual(['alphaSearch', 'openaiImagesEdits', 'openaiImagesGenerations', 'openaiResponses', 'openaiResponsesCompact']);
  expect(Object.isFrozen(chatgptPipelines)).toBe(true);
});

test('normalizes Codex Responses headers and payload, restores terminal output, and records quota', async () => {
  const upstreams = createUpstreamStateRepoStub(record, next => { state = next as ChatGPTUpstreamState; });
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams }));
  const { services, fetcher } = service(() => new Response(`${sse(
    { type: 'response.output_item.done', output_index: 0, item: nativeItem } as const,
    { type: 'response.completed', response: terminal } as const,
  )  }data: [DONE]\n\n`, { headers: { 'x-codex-primary-used-percent': '10', 'x-codex-active-limit': 'codex' } }));
  const exchange = run(chatgptPipelines.openaiResponses, {
    ...entry,
    'request.openaiResponses': move({ model: 'client', input: [], stream: false, temperature: 0.1, max_output_tokens: 100 }),
  }, { services });
  const response = await exchange.result;
  expect(response['response.modelKey']).toBe('wire-model');
  const http = response['response.http'];
  assert(http !== null);
  expect(getHeader(http.headers, 'content-type')).toBe('text/event-stream');
  expect(http.body).toBeNull();
  const result = response['response.openaiResponses'];
  assert(result.kind === 'stream');
  expect(await Array.fromAsync(result.stream)).toMatchObject([
    { ok: true, value: { type: 'response.output_item.done', item: nativeItem } },
    { ok: true, value: { type: 'response.completed', response: { output: [nativeItem] } } },
  ]);
  await exchange.done;
  expect(upstreams.getById).toHaveBeenCalledOnce();
  expect(account().quotaSnapshot).toMatchObject({ codex: { data: { primary_used_percent: 10 } } });

  const [send] = fetcher.mock.calls;
  assert(send !== undefined);
  expect(send[0]).toBe('https://chatgpt.com/backend-api/codex/responses');
  const sent = new Headers(send[1].headers);
  expect(sent.get('originator')).toBe(CHATGPT_ORIGINATOR);
  expect(sent.get('authorization')).toBe('Bearer access-old');
  expect(sent.get('chatgpt-account-id')).toBe('acct');
  expect(sent.get('session-id')).toBe('client-session');
  expect(sent.get('x-client-request-id')).toBe('client-request');
  expect(sent.has('session_id')).toBe(false);
  expect(sent.has('x-extra')).toBe(false);
  expect(sent.has('x-codex-image-turn-id')).toBe(false);
  assert(typeof send[1].body === 'string');
  const body: unknown = JSON.parse(send[1].body);
  expect(body).toMatchObject({
    model: 'wire-model', stream: true, store: false, instructions: "You're a helpful assistant.",
    prompt_cache_key: 'client-session', client_metadata: { 'x-codex-installation-id': account().openaiDeviceId },
  });
  expect(body).not.toHaveProperty('max_output_tokens');
  expect(body).not.toHaveProperty('temperature');
});

test('projects Lite fields through the same invocation without replaying them in the wire body', async () => {
  const tool = { type: 'function', name: 'lookup', parameters: { type: 'object' } } as const;
  const call = { type: 'function_call', id: 'tool-item', call_id: 'tool-call', name: 'lookup', arguments: '{}' };
  const { services, fetcher } = service(() => new Response(sse(
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: terminal },
  )));
  const exchange = run(chatgptPipelines.openaiResponses, {
    ...entry,
    'provider.model': move({ ...model, providerData: { useResponsesLite: true } }),
    'request.openaiResponses': move({ model: 'client', input: [], instructions: 'Be brief.', tools: [tool] }),
  }, { services });
  const response = (await exchange.result)['response.openaiResponses'];
  assert(response.kind === 'stream');
  const items = await Array.fromAsync(response.stream);
  expect(items).toContainEqual(expect.objectContaining({
    ok: true,
    value: expect.objectContaining({
      type: 'response.completed',
      response: expect.objectContaining({ instructions: 'Be brief.', tools: [tool], output: [call] }),
    }),
  }));
  await exchange.done;
  const sent = fetcher.mock.calls[0]?.[1];
  assert(sent !== undefined && typeof sent.body === 'string');
  expect(new Headers(sent.headers).get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
  const body: unknown = JSON.parse(sent.body);
  expect(body).not.toHaveProperty('instructions');
  expect(body).not.toHaveProperty('tools');
  expect(body).toMatchObject({ input: [{ type: 'additional_tools' }, { type: 'message', role: 'developer' }] });
});

test('aborts and joins a live upstream when Codex gives conflicting output indices', async () => {
  const cancel = vi.fn();
  const { services } = service(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse(
        { type: 'response.output_item.added', output_index: 0, item: nativeItem },
        { type: 'response.output_item.done', output_index: 1, item: nativeItem },
      )));
    },
    cancel,
  })));
  const exchange = run(chatgptPipelines.openaiResponses, {
    ...entry,
    'request.openaiResponses': move({ model: 'client', input: [] }),
  }, { services });
  const response = (await exchange.result)['response.openaiResponses'];
  assert(response.kind === 'stream');
  const cursor = response.stream[Symbol.asyncIterator]();
  await expect(cursor.next()).resolves.toMatchObject({ done: false, value: { ok: true, value: { type: 'response.output_item.added' } } });
  await expect(cursor.next()).resolves.toMatchObject({
    done: false,
    value: { ok: false, error: { kind: 'protocol', cause: expect.objectContaining({ message: expect.stringContaining('conflicting output_index') }) } },
  });
  await expect(cursor.next()).resolves.toMatchObject({ done: true });
  await exchange.done;
  expect(cancel).toHaveBeenCalledOnce();
});

test('propagates a Lite projection bug as a pipeline panic', async () => {
  const bug = new TypeError('Lite projection bug');
  const project = vi.spyOn(responsesLite, 'projectChatGPTResponsesEvent').mockImplementationOnce(() => { throw bug; });
  try {
    const { services } = service(() => new Response(sse({ type: 'response.completed', response: terminal })));
    const exchange = run(chatgptPipelines.openaiResponses, {
      ...entry,
      'provider.model': move({ ...model, providerData: { useResponsesLite: true } }),
      'request.openaiResponses': move({ model: 'client', input: [], instructions: 'Be brief.' }),
    }, { services });
    const response = (await exchange.result)['response.openaiResponses'];
    assert(response.kind === 'stream');
    await expect(response.stream[Symbol.asyncIterator]().next()).rejects.toBe(bug);
    await expect(exchange.done).rejects.toBe(bug);
  } finally {
    project.mockRestore();
  }
});

test.each(['generate', 'compact'])('returns a local 503 for a removed account before Codex %s', async mode => {
  initProviderRepo(() => ({ recordUpstreamMetric: vi.fn(), upstreams: { getById: async () => null, saveState: vi.fn() } }));
  const { services, fetcher } = service(() => { throw new Error('Unexpected upstream fetch'); });
  const facts = { ...entry, 'request.openaiResponses': move({ model: 'client', input: [] }) };
  const exchange = mode === 'generate'
    ? run(chatgptPipelines.openaiResponses, facts, { services })
    : run(chatgptPipelines.openaiResponsesCompact, facts, { services });
  await expect(exchange.result).resolves.toMatchObject({
    'response.http': { status: 503, statusText: 'Service Unavailable' },
    'response.openaiResponses': { kind: 'error', source: 'local', error: { error: { type: 'chatgpt_upstream_unavailable' } } },
  });
  await exchange.done;
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([false, true])('drains invalid OAuth responses and preserves parser bugs when injected (%s)', async injectBug => {
  state = { accounts: [{ ...credential(), accessToken: null }] };
  const body = new Response('{"access_token":"private-token"');
  const { services, fetcher } = service(() => body);
  const bug = new TypeError('OAuth parser bug');
  const parse = injectBug ? vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw bug; }) : undefined;
  try {
    const exchange = run(chatgptPipelines.openaiResponses, { ...entry, 'request.openaiResponses': move({ model: 'client', input: [] }) }, { services });
    if (injectBug) {
      await expect(exchange.result).rejects.toBe(bug);
      await expect(exchange.done).rejects.toBe(bug);
    } else {
      const { 'response.openaiResponses': outcome } = await exchange.result;
      expect(outcome).toMatchObject({ kind: 'error', source: 'upstream', error: { error: { type: 'server_error', message: expect.stringContaining('OAuth') } } });
      expect(JSON.stringify(outcome)).not.toContain('private-token');
      await exchange.done;
    }
    expect(fetcher).toHaveBeenCalledOnce();
    expect(body.bodyUsed).toBe(true);
    expect(body.body?.locked).toBe(false);
  } finally {
    parse?.mockRestore();
  }
});

test('drains a renewable 401, rotates credentials once, and replays the compact request', async () => {
  let exhausted = false;
  let attempts = 0;
  const { services, fetcher } = service((url, init) => {
    const bearer = new Headers(init.headers).get('authorization');
    if (url === CHATGPT_OAUTH_TOKEN_URL) {
      expect(exhausted).toBe(true);
      expect(init.body).toContain('refresh_token=refresh-old');
      return Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 });
    }
    if (++attempts === 1) {
      expect(bearer).toBe('Bearer access-old');
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":{"code":"token_expired"}}'));
          controller.close();
          exhausted = true;
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: 401 });
    }
    expect(bearer).toBe('Bearer access-new');
    return Response.json({ id: 'compact', object: 'response.compaction', output: [nativeItem] });
  });
  const exchange = run(chatgptPipelines.openaiResponsesCompact, {
    ...entry,
    'request.openaiResponses': move({ model: 'client', input: [], prompt_cache_options: null, store: true }),
  }, { services });
  const response = await exchange.result;
  expect(response['response.openaiResponses']).toEqual({ kind: 'result', result: { id: 'compact', object: 'response.compaction', output: [nativeItem] } });
  await exchange.done;
  expect(account()).toMatchObject({ refresh_token: 'refresh-new', accessToken: { token: 'access-new' } });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://chatgpt.com/backend-api/codex/responses/compact', CHATGPT_OAUTH_TOKEN_URL, 'https://chatgpt.com/backend-api/codex/responses/compact',
  ]);
  expect(fetcher.mock.calls[2]?.[1].body).toBe(fetcher.mock.calls[0]?.[1].body);
  const body = fetcher.mock.calls[0]?.[1].body;
  assert(typeof body === 'string');
  const parsed: unknown = JSON.parse(body);
  expect(parsed).toMatchObject({ model: 'wire-model', instructions: "You're a helpful assistant.", prompt_cache_options: null });
  expect(parsed).not.toHaveProperty('stream');
  expect(parsed).not.toHaveProperty('store');
});

test('relays the OAuth failure response and persists the refresh failure', async () => {
  account().accessToken = null;
  const oauth = { error: { code: 'invalid_grant', message: 'Revoked' } };
  const { services, fetcher } = service(url => {
    expect(url).toBe(CHATGPT_OAUTH_TOKEN_URL);
    return Response.json(oauth, { status: 400, headers: [['set-cookie', 'first=yes'], ['set-cookie', 'second=yes']] });
  });
  const exchange = run(chatgptPipelines.alphaSearch, { ...entry, 'request.alphaSearch': move({ query: 'example' }) }, { services });
  const response = await exchange.result;
  await exchange.done;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(account()).toMatchObject({ state: 'refresh_failed', state_message: 'Revoked' });
  expect(response['response.modelKey']).toBe('wire-model');
  expect(response['response.alphaSearch']).toEqual({ kind: 'error', source: 'upstream', error: oauth });
  const http = response['response.http'];
  assert(http !== null);
  expect(http.status).toBe(400);
  expect(getHeaders(http.headers, 'set-cookie')).toEqual(['first=yes', 'second=yes']);
});

test('returns an OAuth transport failure with its original cause and no HTTP head', async () => {
  account().accessToken = null;
  const failure = { kind: 'transport', cause: new Error('OAuth connection closed') } as const;
  const fetcher = vi.fn<ReturnType<ChatGPTServices['fetcher']>>().mockResolvedValue({ ok: false, error: failure });
  const exchange = run(chatgptPipelines.alphaSearch, {
    ...entry,
    'request.alphaSearch': move({ query: 'example' }),
  }, { services: { fetcher: () => fetcher, chatgpt: createChatGPTService() } });
  const result = await exchange.result;
  await exchange.done;
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(CHATGPT_OAUTH_TOKEN_URL, expect.objectContaining({ method: 'POST' }));
  expect(result['response.http']).toBeNull();
  const outcome = result['response.alphaSearch'];
  assert(outcome.kind === 'error');
  expect(outcome).toMatchObject({ source: 'upstream', error: { error: { message: failure.cause.message, type: 'api_error' } } });
  expect(outcome.cause).toBe(failure);
  expect(account().state).toBe('active');
});

test.each([true, false])('persists terminal upstream 401 for a renewable credential of %s', async renewable => {
  if (!renewable) account().refresh_token = null;
  const upstreamError = { error: { code: 'token_invalidated', message: 'Session revoked' } };
  const { services, fetcher } = service(() => Response.json(upstreamError, { status: 401, headers: { 'x-upstream': 'yes' } }));
  const input = { ...entry, 'request.openaiResponses': move({ model: 'client', input: [] }) };
  const first = run(chatgptPipelines.openaiResponses, input, { services });
  const result = await first.result;
  await first.done;
  expect(result['response.http']?.status).toBe(renewable ? 503 : 401);
  expect(result['response.openaiResponses']).toEqual(renewable
    ? { kind: 'error', source: 'local', error: { error: { type: 'chatgpt_upstream_unavailable', message: 'ChatGPT session terminated: Session revoked' } } }
    : { kind: 'error', source: 'upstream', error: upstreamError });
  expect(account()).toMatchObject({ state: 'session_terminated', accessToken: null });

  const second = run(chatgptPipelines.openaiResponses, input, { services });
  expect(await second.result).toMatchObject({
    'response.http': { status: 503 }, 'response.openaiResponses': { kind: 'error', source: 'local' },
  });
  await second.done;
  expect(fetcher).toHaveBeenCalledOnce();
});

test('serializes Alpha Search and both image operations with their own fields and paths', async () => {
  const { services, fetcher } = service(() => Response.json({ data: ['upstream result'] }));
  const search = run(chatgptPipelines.alphaSearch, { ...entry, 'request.alphaSearch': move({ id: ' query-id ', query: 'x' }) }, { services });
  const generation = run(chatgptPipelines.openaiImagesGenerations, {
    ...entry, 'request.openaiImagesGenerations': move({ model: 'client', prompt: 'A tree' }),
  }, { services });
  const edit = run(chatgptPipelines.openaiImagesEdits, {
    ...entry, 'request.openaiImagesEdits': move({
      images: [{ type: 'upload' as const, file: { name: 'source.png', type: 'image/png', bytes: new TextEncoder().encode('body') } }],
      parameters: { prompt: 'A bigger tree' },
    }),
  }, { services });
  expect((await search.result)['response.alphaSearch']).toEqual({ kind: 'result', result: { data: ['upstream result'] } });
  expect((await generation.result)['response.openaiImagesGenerations']).toEqual({ kind: 'result', result: { data: ['upstream result'] } });
  expect((await edit.result)['response.openaiImagesEdits']).toEqual({ kind: 'result', result: { data: ['upstream result'] } });
  await Promise.all([search.done, generation.done, edit.done]);
  const calls = Object.fromEntries(fetcher.mock.calls.map(([url, init]) => [new URL(url).pathname, init]));
  const searchRequest = calls['/backend-api/codex/alpha/search'];
  const generationRequest = calls['/backend-api/codex/images/generations'];
  const editRequest = calls['/backend-api/codex/images/edits'];
  assert(searchRequest !== undefined && generationRequest !== undefined && editRequest !== undefined);
  expect(searchRequest.body).toBe('{"id":"query-id","query":"x","model":"wire-model"}');
  expect(new Headers(searchRequest.headers).get('thread-id')).toBe('query-id');
  expect(generationRequest.body).toBe('{"model":"wire-model","prompt":"A tree"}');
  expect(editRequest.body).toBe('{"prompt":"A bigger tree","images":[{"image_url":"data:image/png;base64,Ym9keQ=="}],"model":"wire-model"}');
  for (const { headers } of [generationRequest, editRequest]) {
    expect(new Headers(headers).get('x-codex-image-turn-id')).toBe('image-turn');
    expect(new Headers(headers).get('originator')).toBe('client-origin');
  }
});

test('uses the hydrated plan for the image gate and formats a non-JSON upstream failure', async () => {
  const accessToken = account().accessToken;
  assert(accessToken !== null);
  accessToken.planType = 'free';
  const { services, fetcher } = service(() => new Response('upstream refused search', { status: 422, headers: { 'x-upstream': 'kept' } }));
  const image = run(chatgptPipelines.openaiImagesGenerations, { ...entry, 'request.openaiImagesGenerations': move({ model: 'client', prompt: 'A tree' }) }, { services });
  expect(await image.result).toMatchObject({
    'response.http': { status: 403 }, 'response.openaiImagesGenerations': { kind: 'error', source: 'local', error: { error: { type: 'image_tools_unavailable' } } },
  });
  await image.done;
  expect(fetcher).not.toHaveBeenCalled();

  const search = run(chatgptPipelines.alphaSearch, { ...entry, 'request.alphaSearch': move({ query: 'take it' }) }, { services });
  expect(await search.result).toMatchObject({
    'response.http': { status: 422, headers: expect.arrayContaining([['x-upstream', 'kept']]) },
    'response.alphaSearch': { kind: 'error', source: 'upstream', error: { error: { type: 'api_error', message: 'upstream refused search' } } },
  });
  await search.done;
});

test('preserves the final upstream 401 after one replay of the prepared Lite generation', async () => {
  const reason = { error: { code: 'expired_token', message: 'Expired' } };
  const { services, fetcher } = service(url => url === CHATGPT_OAUTH_TOKEN_URL
    ? Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
    : Response.json(reason, { status: 401, headers: { [CHATGPT_RESPONSES_LITE_HEADER]: 'retained' } }));
  const exchange = run(chatgptPipelines.openaiResponses, {
    ...entry,
    'provider.model': move({ ...model, providerData: { useResponsesLite: true } }),
    'request.openaiResponses': move({ model: 'client', input: [], instructions: 'Be brief.' }),
  }, { services });
  const result = await exchange.result;
  await exchange.done;
  expect(result['response.openaiResponses']).toEqual({ kind: 'error', source: 'upstream', error: reason });
  const http = result['response.http'];
  assert(http !== null);
  expect(http.status).toBe(401);
  expect(getHeader(http.headers, CHATGPT_RESPONSES_LITE_HEADER)).toBe('retained');
  expect(fetcher).toHaveBeenCalledTimes(3);
  const first = fetcher.mock.calls[0]?.[1];
  const retry = fetcher.mock.calls[2]?.[1];
  assert(first !== undefined && retry !== undefined);
  expect(retry.body).toBe(first.body);
  const headers = [new Headers(first.headers), new Headers(retry.headers)] as const;
  expect(headers.map(header => header.get(CHATGPT_RESPONSES_LITE_HEADER))).toEqual(['true', 'true']);
  expect(headers.map(header => header.get('authorization'))).toEqual(['Bearer access-old', 'Bearer access-new']);
  headers.forEach(header => header.delete('authorization'));
  expect([...headers[0]]).toEqual([...headers[1]]);
});

test('retains the compact result around a caller-positioned tools carrier', async () => {
  const { services } = service((_url, init) => {
    assert(typeof init.body === 'string');
    const body = JSON.parse(init.body) as { input: unknown[] };
    expect(body.input).toMatchObject([
      { type: 'additional_tools' },
      { type: 'message', role: 'developer' },
      { type: 'additional_tools', id: 'at_caller' },
      { type: 'message', role: 'user' },
    ]);
    return Response.json({ id: 'compact', object: 'response.compaction', output: [...body.input, nativeItem] });
  });
  const exchange = run(chatgptPipelines.openaiResponsesCompact, {
    ...entry,
    'provider.model': move({ ...model, providerData: { useResponsesLite: true } }),
    'request.openaiResponses': move({
      model: 'client', instructions: 'Base',
      input: [
        { type: 'additional_tools' as const, role: 'developer' as const, id: 'at_caller', tools: [{ type: 'custom' as const, name: 'patch' }] },
        { type: 'message' as const, role: 'user' as const, content: 'Continue.' },
      ],
    }),
  }, { services });
  const result = (await exchange.result)['response.openaiResponses'];
  await exchange.done;
  assert(result.kind === 'result' && 'output' in result.result);
  expect(result.result.output).toMatchObject([
    { type: 'additional_tools' }, { type: 'message' }, { id: 'at_caller' }, { type: 'message' }, nativeItem,
  ]);
});

test('records a rate limit, replaces the same family on success, and preserves it on a headerless image', async () => {
  const other = { fetchedAt: 1, data: { observed_at: '2026-01-01T00:00:00Z', active_limit: 'other', primary_used_percent: 5 } };
  account().quotaSnapshot = { other };
  const quotaHeaders = { 'x-codex-active-limit': 'premium', 'x-codex-primary-reset-after-seconds': '3600' };
  let turn = 0;
  const { services } = service(url => {
    if (url.endsWith('/images/generations')) return Response.json({ data: [] });
    if (turn++ === 0) return Response.json({ error: { message: 'Limited' } }, {
      status: 429, headers: { ...quotaHeaders, 'x-codex-primary-used-percent': '100' },
    });
    return new Response(sse({ type: 'response.completed', response: terminal }), {
      headers: { ...quotaHeaders, 'x-codex-primary-used-percent': '42' },
    });
  });
  const input = { ...entry, 'request.openaiResponses': move({ model: 'client', input: [] }) };
  const limited = run(chatgptPipelines.openaiResponses, input, { services });
  expect((await limited.result)['response.http']?.status).toBe(429);
  await limited.done;
  const snapshot = account().quotaSnapshot?.premium.data;
  assert(snapshot !== undefined);
  expect(Date.parse(snapshot.ratelimited_until!) - Date.parse(snapshot.observed_at)).toBe(3_600_000);

  const successful = run(chatgptPipelines.openaiResponses, input, { services });
  const outcome = (await successful.result)['response.openaiResponses'];
  assert(outcome.kind === 'stream');
  await Array.fromAsync(outcome.stream);
  await successful.done;
  expect(account().quotaSnapshot?.premium.data).toMatchObject({ primary_used_percent: 42 });
  expect(account().quotaSnapshot?.premium.data.ratelimited_until).toBeUndefined();
  expect(account().quotaSnapshot?.other).toEqual(other);

  const before = account().quotaSnapshot;
  const image = run(chatgptPipelines.openaiImagesGenerations, {
    ...entry, 'request.openaiImagesGenerations': move({ model: 'client', prompt: 'A tree' }),
  }, { services });
  expect((await image.result)['response.http']?.status).toBe(200);
  await image.done;
  expect(account().quotaSnapshot).toEqual(before);
});

test('checks the plan from a newly minted bearer before sending an image request', async () => {
  account().accessToken = null;
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'free' } })).toString('base64url');
  const { services, fetcher } = service(url => {
    expect(url).toBe(CHATGPT_OAUTH_TOKEN_URL);
    return Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600, id_token: `e30.${claims}.signature` });
  });
  const image = run(chatgptPipelines.openaiImagesGenerations, {
    ...entry, 'request.openaiImagesGenerations': move({ model: 'client', prompt: 'A tree' }),
  }, { services });
  expect((await image.result)['response.http']?.status).toBe(403);
  await image.done;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(account().accessToken).toMatchObject({ token: 'access-new', planType: 'free' });
});

test('uses the plan of a sibling bearer that wins before retry rather than minting again', async () => {
  const winner = { ...credential().accessToken!, token: 'sibling-bearer', planType: 'free' };
  const { services, fetcher } = service((_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-old');
    account().accessToken = winner;
    account().refresh_token = 'sibling-refresh';
    return Response.json({ error: { code: 'expired_token', message: 'Expired' } }, { status: 401 });
  });
  const image = run(chatgptPipelines.openaiImagesGenerations, {
    ...entry, 'request.openaiImagesGenerations': move({ model: 'client', prompt: 'A tree' }),
  }, { services });
  expect((await image.result)['response.http']?.status).toBe(403);
  await image.done;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(account().accessToken).toEqual(winner);
});
