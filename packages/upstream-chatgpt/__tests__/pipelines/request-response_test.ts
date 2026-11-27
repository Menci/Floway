import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CHATGPT_ORIGINATOR, CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY, CHATGPT_RESPONSES_LITE_HEADER, CHATGPT_USER_AGENT } from '../../src/constants.ts';
import { createChatGPTService, chatgptPipelines } from '../../src/index.ts';
import type { ChatGPTAccountCredential, ChatGPTUpstreamState } from '../../src/state.ts';
import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from '../upstream-state-repo.ts';
import { getHeader, HttpTransportError, type Fetcher, type HttpRequestFact } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesCompactPayload, CanonicalOpenAIResponsesPayload, OpenAIResponsesCompactionItemEx, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { stubUpstreamModel } from '@floway-dev/test-utils';
import { initUpstreamRuntimeRepo, toUpstreamModelSnapshot, toUpstreamSnapshot, type UpstreamRecord } from '@floway-dev/upstream';

const record: UpstreamRecord = {
  id: 'chatgpt-pipeline',
  kind: 'chatgpt',
  name: 'ChatGPT',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: null, chatgptAccountId: 'account', chatgptUserId: null, planType: 'plus' }] },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
};

const account: ChatGPTAccountCredential = {
  chatgptAccountId: 'account',
  refresh_token: 'refresh',
  openaiDeviceId: '11111111-2222-4333-8444-555555555555',
  state: 'active',
  state_updated_at: '2026-01-01T00:00:00.000Z',
  accessToken: { token: 'access', expiresAt: Date.now() + 3_600_000, refreshedAt: new Date().toISOString() },
  quotaSnapshot: null,
};
let state: ChatGPTUpstreamState;
let repo: UpstreamStateRepoStub;

beforeEach(() => {
  state = { accounts: [structuredClone(account)] };
  repo = createUpstreamStateRepoStub(() => ({ ...record, state }), next => { state = next as ChatGPTUpstreamState; });
  initUpstreamRuntimeRepo(() => ({ upstreams: repo, recordUpstreamMetric: async () => {} }));
});

const callerHttp: HttpRequestFact = {
  url: 'https://gateway.test/v1/responses',
  method: 'POST',
  body: new Uint8Array(),
  headers: [
    ['authorization', 'caller-secret'],
    ['x-codex-turn-metadata', '{"turn_id":"caller-turn","session_id":"socket-session"}'],
    ['session-id', 'header-session'],
    ['x-private', 'discard'],
  ],
};

const upstream = toUpstreamSnapshot(record);
const model = toUpstreamModelSnapshot(stubUpstreamModel({ id: 'gpt-5.4' }));
const liteModel = toUpstreamModelSnapshot(stubUpstreamModel({ id: 'gpt-5.4-lite', upstreamData: { useResponsesLite: true } }));
const responses = {
  http: callerHttp, upstream, model,
  openaiResponses: { model: 'published-model', input: [], instructions: 'Be brief.' },
};

const host = (fetcher: Fetcher, signal = new AbortController().signal) => {
  const detached: Promise<unknown>[] = [];
  return {
    services: { fetcher: () => fetcher, chatgpt: createChatGPTService() },
    signal,
    waitUntil(work: Promise<unknown>) { detached.push(work); },
    detached,
  };
};

const responseChunk = (type: 'created' | 'completed'): Uint8Array => new TextEncoder().encode(
  `event: response.${type}\ndata: ${JSON.stringify({
    type: `response.${type}`,
    response: {
      id: 'r', object: 'response', status: type === 'completed' ? 'completed' : 'in_progress',
      model: model.id, output: [], error: null, incomplete_details: null,
    },
  })}\n\n`,
);

const codexEvents = (events: readonly Record<string, unknown>[], headers: HeadersInit = {}): Response =>
  new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, { headers });

const compactResult = { id: 'cmp', object: 'response.compaction', output: [] };

const readResponses = async (fetcher: Fetcher, input: ReturnType<typeof requestState> = responses) => {
  const options = host(fetcher);
  const running = run(asEntry(chatgptPipelines.openaiResponses), input, options);
  const answer = await running.result;
  const outcome = answer.openaiResponses;
  const events = [];
  if (outcome.kind === 'stream') for await (const event of running.read(outcome.stream)) events.push(event);
  running.discard(answer);
  await Promise.all(options.detached);
  return { http: answer.http, outcome, events };
};

const requestState = (body: CanonicalOpenAIResponsesPayload, headers: HttpRequestFact['headers'] = [], selectedModel = model) => ({
  http: { ...callerHttp, headers }, upstream, model: selectedModel, openaiResponses: body,
});

const readCompact = async (fetcher: Fetcher, body: CanonicalOpenAIResponsesCompactPayload, selectedModel = liteModel) => {
  const options = host(fetcher);
  const running = run(asEntry(chatgptPipelines.openaiResponsesCompact), {
    http: callerHttp, upstream, model: selectedModel, openaiResponsesCompact: body,
  }, options);
  const answer = await running.result;
  running.discard(answer);
  await Promise.all(options.detached);
  return { http: answer.http, outcome: answer.openaiResponsesCompact };
};

describe('ChatGPT pipeline', () => {
  test('Codex completion closes a still-open body and keeps the terminal event', async () => {
    const cancel = vi.fn();
    const transport: Fetcher = async (url, init) => {
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      const { headers, body } = init!;
      expect(Object.fromEntries(new Headers(headers))).toMatchObject({
        authorization: 'Bearer access',
        'chatgpt-account-id': 'account',
        'session-id': 'socket-session',
        accept: 'text/event-stream',
      });
      expect(new Headers(headers).has('x-private')).toBe(false);
      expect(JSON.parse(body as string)).toMatchObject({
        model: model.id, store: false, stream: true, prompt_cache_key: 'socket-session',
        client_metadata: { session_id: 'socket-session', turn_id: 'caller-turn' },
      });
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(responseChunk('completed')); },
        cancel,
      }), { headers: { 'x-upstream-result': 'generation' } });
    };
    const options = host(transport);
    const running = run(asEntry(chatgptPipelines.openaiResponses), responses, options);
    const answer = await running.result;
    expect(answer.http).toMatchObject({ status: 200, body: null, headers: expect.arrayContaining([['content-type', 'text/event-stream']]) });
    expect(Object.keys(answer).sort()).toEqual(['http', 'openaiResponses']);
    if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected Responses stream');
    expect(cancel).not.toHaveBeenCalled();
    const items = [];
    for await (const item of running.read(answer.openaiResponses.stream)) items.push(item);
    expect(items.at(-1)).toMatchObject({ ok: true, value: { type: 'response.completed' } });
    expect(cancel).toHaveBeenCalledOnce();
    expect(options.detached).toHaveLength(1);
    running.discard(answer);
    await Promise.all(options.detached);
  });

  test('a body read failure before a Codex terminal remains a transport outcome', async () => {
    const cause = new HttpTransportError(new Error('peer reset'));
    let peer!: ReadableStreamDefaultController<Uint8Array>;
    const options = host(async () => new Response(new ReadableStream({
      start(controller) {
        peer = controller;
        controller.enqueue(responseChunk('created'));
      },
    })));
    const running = run(asEntry(chatgptPipelines.openaiResponses), responses, options);
    const answer = await running.result;
    if (answer.openaiResponses.kind !== 'stream') throw new Error('Expected Responses stream');
    const cursor = running.read(answer.openaiResponses.stream);
    expect(await cursor.next()).toMatchObject({ value: { ok: true, value: { type: 'response.created' } } });
    peer.error(cause);
    const failure = await cursor.next();
    expect(failure).toEqual({ done: false, value: { ok: false, error: { kind: 'transport', cause } } });
    expect(await cursor.next()).toEqual({ done: true, value: undefined });
    running.discard(answer);
    await Promise.all(options.detached);
  });

  test('dedicated compact retries a renewable 401 with the same Lite request', async () => {
    const sent: { bearer: string | null; body: unknown; session: string | null }[] = [];
    const compactResult = { id: 'cmp', object: 'response.compaction', output: [] };
    const options = host(async (url, init) => {
      if (String(url).endsWith('/oauth/token')) {
        return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 });
      }
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
      const headers = new Headers(init!.headers);
      expect(headers.get('accept')).toBe('application/json');
      expect(headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
      sent.push({ bearer: headers.get('authorization'), session: headers.get('session-id'), body: JSON.parse(init!.body as string) });
      return sent.length === 1
        ? Response.json({ error: { code: 'token_expired', message: 'Expired' } }, { status: 401 })
        : Response.json(compactResult);
    });
    const body = {
      model: 'published-model', input: [], instructions: 'Keep decisions.', store: true, prompt_cache_options: null,
      tools: [{ type: 'custom', name: 'compact_tool' }],
    };
    const running = run(asEntry(chatgptPipelines.openaiResponsesCompact), {
      http: callerHttp, upstream, model: liteModel, openaiResponsesCompact: body,
    }, options);
    const answer = await running.result;
    expect(answer.openaiResponsesCompact).toEqual({ kind: 'result', result: compactResult });
    expect(sent.map(item => item.bearer)).toEqual(['Bearer access', 'Bearer new-access']);
    expect(sent[0]!.body).toEqual(sent[1]!.body);
    expect(sent[0]!.session).toBe(sent[1]!.session);
    expect(sent[1]!.body).toMatchObject({
      model: liteModel.id, prompt_cache_options: null, parallel_tool_calls: false, reasoning: { context: 'all_turns' },
      input: [
        { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'compact_tool' }] }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Keep decisions.' }] },
      ],
    });
    expect(sent[1]!.body).not.toHaveProperty('store');
    expect(sent[1]!.body).not.toHaveProperty('stream');
    expect(sent[1]!.body).not.toHaveProperty('instructions');
    expect(state.accounts[0]).toMatchObject({ refresh_token: 'new-refresh', accessToken: { token: 'new-access' } });
    running.discard(answer);
    await Promise.all(options.detached);
  });

  test.each([true, false])('catalog useResponsesLite=%s selects the wire format for both operations', async useResponsesLite => {
    const selectedModel = { ...model, upstreamData: { useResponsesLite } };
    const tools = [{ type: 'function' as const, name: 'lookup', parameters: { type: 'object' } }];
    const payload = {
      model: 'published-model',
      input: [{ type: 'message' as const, role: 'user' as const, content: [{ type: 'input_audio' as const, audio_url: 'data:audio/wav;base64,YQ==' }] }],
      instructions: 'Base', tools, parallel_tool_calls: true,
      reasoning: { effort: 'future_effort', context: 'current_turn' },
      text: { verbosity: 'high' as const }, service_tier: 'ultrafast', tool_choice: 'auto' as const,
      client_metadata: { [CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY]: String(!useResponsesLite), retained: 'yes' },
      temperature: 0.5,
    };
    const original = structuredClone(payload);
    const checkWire = (init: NonNullable<Parameters<Fetcher>[1]>) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(new Headers(init.headers).get(CHATGPT_RESPONSES_LITE_HEADER)).toBe(useResponsesLite ? 'true' : null);
      expect(body).toMatchObject({ model: model.id, text: payload.text, service_tier: 'ultrafast', parallel_tool_calls: !useResponsesLite });
      expect(body).not.toHaveProperty('temperature');
      if (useResponsesLite) {
        expect(body).not.toHaveProperty('tools');
        expect(body).not.toHaveProperty('instructions');
        expect(body).toMatchObject({ reasoning: { effort: 'future_effort', context: 'all_turns' } });
        expect(body.input).toMatchObject([
          { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools }] },
          { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Base' }] },
          ...payload.input,
        ]);
      } else {
        expect(body).toMatchObject({ tools, instructions: 'Base', input: payload.input, reasoning: payload.reasoning });
      }
      return body;
    };
    const generated = await readResponses(async (_url, init) => {
      const body = checkWire(init!);
      expect(body).toMatchObject({ client_metadata: { retained: 'yes' }, tool_choice: 'auto', stream: true, store: false });
      expect(body.client_metadata).not.toHaveProperty(CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY);
      return codexEvents([], { [CHATGPT_RESPONSES_LITE_HEADER]: 'true', 'x-upstream-custom': 'retained' });
    }, requestState(payload, [[CHATGPT_RESPONSES_LITE_HEADER, String(!useResponsesLite)]], selectedModel));
    expect(generated.outcome.kind).toBe('stream');
    expect(getHeader(generated.http!.headers, CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
    expect(getHeader(generated.http!.headers, 'x-upstream-custom')).toBe('retained');
    const compacted = await readCompact(async (_url, init) => {
      const body = checkWire(init!);
      for (const field of ['stream', 'store', 'client_metadata', 'tool_choice']) expect(body).not.toHaveProperty(field);
      return Response.json(compactResult);
    }, payload, selectedModel);
    expect(compacted.outcome).toEqual({ kind: 'result', result: compactResult });
    expect(payload).toEqual(original);
  });

  test('Lite compact keeps the caller tools carrier and the complete returned output window', async () => {
    const opaque = { type: 'compaction', id: 'cmp_item', encrypted_content: 'opaque+encrypted==' };
    const carrier = { type: 'additional_tools' as const, role: 'developer' as const, id: 'at_caller', tools: [{ type: 'custom' as const, name: 'patch' }] };
    const user = { type: 'message' as const, role: 'user' as const, content: 'Continue' };
    let sent: unknown[] = [];
    const compacted = await readCompact(async (_url, init) => {
      sent = (JSON.parse(init!.body as string) as { input: unknown[] }).input;
      expect(sent).toContainEqual(carrier);
      expect(sent).toContainEqual(user);
      return Response.json({ ...compactResult, output: [...sent, opaque] });
    }, { model: 'published-model', input: [carrier, user], instructions: 'Old instructions' });
    expect(compacted.outcome).toEqual({ kind: 'result', result: { ...compactResult, output: [...sent, opaque] } });
  });

  test('generation retries with identical Lite bytes and metadata, using only the refreshed bearer', async () => {
    const sent: { body: unknown; headers: Headers }[] = [];
    const answer = await readResponses(async (url, init) => {
      if (String(url).endsWith('/oauth/token')) {
        return Response.json({ access_token: 'retried', refresh_token: 'rotated', expires_in: 3600 });
      }
      sent.push({ body: init!.body, headers: new Headers(init!.headers) });
      return sent.length === 1
        ? Response.json({ error: { code: 'expired_token', message: 'Expired' } }, { status: 401 })
        : codexEvents([]);
    }, requestState({ ...responses.openaiResponses, tools: [{ type: 'custom', name: 'lookup' }] }, [], liteModel));
    expect(answer.outcome.kind).toBe('stream');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toBe(sent[0]!.body);
    expect(sent[0]!.headers.get('authorization')).toBe('Bearer access');
    expect(sent[1]!.headers.get('authorization')).toBe('Bearer retried');
    sent.forEach(request => request.headers.delete('authorization'));
    expect([...sent[1]!.headers]).toEqual([...sent[0]!.headers]);
    expect(sent[0]!.headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
    expect(state.accounts[0]).toMatchObject({ refresh_token: 'rotated', accessToken: { token: 'retried' } });
  });

  test('restores terminal compaction output before returning events', async () => {
    const item: OpenAIResponsesCompactionItemEx = {
      type: 'compaction', id: 'cmp_native', encrypted_content: 'OPAQUE_NATIVE_BLOB',
      metadata: { turn_id: 'turn_native' }, internal_chat_message_metadata_passthrough: { turn_id: 'turn_native' },
    };
    const terminal: OpenAIResponsesResultEx = {
      id: 'resp_native', object: 'response', model: model.id, status: 'completed', output: [],
      error: null, incomplete_details: null, usage: { input_tokens: 15, output_tokens: 25, total_tokens: 40 },
    };
    const { events } = await readResponses(async () => codexEvents([
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.compaction.compacting', item_id: item.id, output_index: 0 },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: terminal },
    ]));
    expect(events).toMatchObject([
      { ok: true, value: { type: 'response.output_item.added', item } },
      { ok: true, value: { type: 'response.compaction.compacting', item_id: item.id } },
      { ok: true, value: { type: 'response.output_item.done', item } },
      { ok: true, value: { type: 'response.completed', response: { ...terminal, output: [item] } } },
    ]);
  });

  test('Lite projects moved response fields and preserves opaque items and future events', async () => {
    const tools = [{ type: 'function' as const, name: 'lookup', parameters: { type: 'object' } }];
    const wireCall = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', namespace: 'functions', arguments: '{}', status: 'completed', future: 'retained' };
    const opaque = { type: 'reasoning', id: 'rs_opaque', summary: [], encrypted_content: 'opaque+encrypted==' };
    const future = { type: 'response.future', data: { retained: true }, sequence_number: 1 };
    const wireResponse = {
      id: 'resp_1', object: 'response', model: liteModel.id, status: 'completed', error: null, incomplete_details: null,
      output: [wireCall, opaque], instructions: null, tools: [], parallel_tool_calls: false,
      reasoning: { effort: 'medium', summary: 'detailed', context: 'all_turns', mode: 'future_mode' },
      service_tier: 'future_tier', tool_choice: 'auto', future: 'retained',
    };
    const { events, http } = await readResponses(async () => codexEvents([
      { type: 'response.output_item.added', output_index: 0, item: wireCall },
      future,
      { type: 'response.output_item.done', output_index: 0, item: wireCall },
      { type: 'response.completed', response: wireResponse },
    ], { [CHATGPT_RESPONSES_LITE_HEADER]: 'true' }), requestState({ ...responses.openaiResponses, tools }, [], liteModel));
    expect(getHeader(http!.headers, 'content-type')).toBe('text/event-stream');
    expect(events).toMatchObject([
      { ok: true, value: { type: 'response.output_item.added', item: wireCall } },
      { ok: true, value: future },
      { ok: true, value: { type: 'response.output_item.done', item: wireCall } },
      { ok: true, value: { type: 'response.completed', response: { ...wireResponse, tools, instructions: 'Be brief.' } } },
    ]);
  });

  test('Codex strips unsupported parameters and forwards developer messages with default instructions', async () => {
    const input: CanonicalOpenAIResponsesPayload['input'] = [
      { type: 'message', role: 'developer', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'developer', content: 'inline instructions' },
    ];
    const unsupported = {
      max_output_tokens: 1024, temperature: 0.7, top_p: 0.9, frequency_penalty: 0.1, presence_penalty: 0.2,
      user: 'caller', metadata: { trace_id: 'abc' }, prompt_cache_retention: '24h', safety_identifier: 'caller',
      stream_options: { include_obfuscation: false, include_usage: true },
    };
    const payload = { model: 'published-model', input, ...unsupported };
    await readResponses(async (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ input, instructions: "You're a helpful assistant." });
      for (const field of Object.keys(unsupported)) expect(body).not.toHaveProperty(field);
      return codexEvents([]);
    }, requestState(payload));
  });

  test('Codex projects stable session identity while giving per-turn body metadata precedence', async () => {
    const sent: { headers: Headers; body: Record<string, unknown> }[] = [];
    const transport: Fetcher = async (_url, init) => {
      sent.push({ headers: new Headers(init!.headers), body: JSON.parse(init!.body as string) as Record<string, unknown> });
      return codexEvents([]);
    };
    const headers: HttpRequestFact['headers'] = [
      ['session-id', 'stable-session'], ['x-codex-turn-metadata', '{"window_id":"old-window","request_kind":"turn"}'],
      ['originator', 'caller'], ['cf-connecting-ip', '203.0.113.10'], ['x-real-ip', '203.0.113.10'], ['forwarded', 'for=203.0.113.10'],
      ['openai-beta', 'responses=experimental'], ['x-codex-beta-features', 'responses_websockets=2026-02-06'],
    ];
    const basePayload = { model: 'published-model', input: [] };
    await readResponses(transport, requestState(basePayload, headers));
    await readResponses(transport, requestState({ ...basePayload, prompt_cache_key: null }, headers));
    const toolNamespaces = { namespaces: [{ name: 'shell', tools: ['exec'] }] };
    const thirdPayload = {
      ...basePayload, prompt_cache_key: 'caller-cache',
      client_metadata: {
        session_id: 'body-session', 'x-codex-installation-id': 'caller-installation',
        'x-codex-turn-metadata': JSON.stringify({
          window_id: 'new-window', request_kind: 'compaction', compaction: { trigger: 'auto', reason: 'context_limit' },
          turn_started_at_unix_ms: 1700000000002, tool_namespaces_info: toolNamespaces,
        }),
      },
    };
    await readResponses(transport, requestState(thirdPayload, headers));
    const [first, second, third] = sent;
    expect(Object.fromEntries(first!.headers)).toMatchObject({
      authorization: 'Bearer access', 'chatgpt-account-id': 'account', originator: CHATGPT_ORIGINATOR, 'user-agent': CHATGPT_USER_AGENT,
      accept: 'text/event-stream', 'session-id': 'stable-session', 'thread-id': 'stable-session', 'x-client-request-id': 'stable-session',
      'x-codex-window-id': 'old-window',
    });
    for (const noise of ['cf-connecting-ip', 'x-real-ip', 'forwarded', 'openai-beta', 'x-codex-beta-features']) expect(first!.headers.has(noise)).toBe(false);
    expect(second!.headers.get('x-codex-window-id')).toBe('old-window');
    expect(first!.headers.get('x-codex-turn-metadata')).not.toBe(second!.headers.get('x-codex-turn-metadata'));
    expect(first!.body.prompt_cache_key).toBe('stable-session');
    expect(second!.body).toHaveProperty('prompt_cache_key', null);
    expect(third!.body.prompt_cache_key).toBe('caller-cache');
    const metadata = JSON.parse(third!.headers.get('x-codex-turn-metadata')!) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      installation_id: 'caller-installation', session_id: 'body-session', window_id: 'new-window', request_kind: 'compaction',
      compaction: { trigger: 'auto', reason: 'context_limit' }, turn_started_at_unix_ms: 1700000000002,
    });
    expect(metadata).not.toHaveProperty('tool_namespaces_info');
    const bodyMetadata = third!.body.client_metadata as Record<string, string>;
    expect(JSON.parse(bodyMetadata['x-codex-turn-metadata']!)).toMatchObject({ ...metadata, tool_namespaces_info: toolNamespaces });
  });

  test.each([400, 429, 503])('non-JSON %s preserves the upstream head and text in the protocol error', async status => {
    const bytes = 'upstream bytes\nnot necessarily JSON';
    const fetcher: Fetcher = async () => new Response(bytes, {
      status, statusText: 'Upstream failure',
      headers: { 'content-type': 'application/problem+json', 'x-upstream-custom': 'retained', [CHATGPT_RESPONSES_LITE_HEADER]: 'false' },
    });
    const generated = await readResponses(fetcher);
    const compacted = await readCompact(fetcher, { model: 'published-model', input: [] });
    for (const answer of [generated, compacted]) {
      expect(answer.http).toMatchObject({ status, statusText: 'Upstream failure' });
      expect(getHeader(answer.http!.headers, 'content-type')).toBe('application/problem+json');
      expect(getHeader(answer.http!.headers, CHATGPT_RESPONSES_LITE_HEADER)).toBe('false');
      expect(getHeader(answer.http!.headers, 'x-upstream-custom')).toBe('retained');
      expect(answer.outcome).toMatchObject({ kind: 'error', source: 'upstream', error: { error: { message: bytes } } });
    }
  });

  test('a terminal 401 persists session termination before reporting unavailability', async () => {
    const fetcher = vi.fn<Fetcher>(async () => Response.json({ error: { code: 'token_invalidated', message: 'session ended' } }, { status: 401 }));
    const answer = await readResponses(fetcher);
    expect(answer.http?.status).toBe(503);
    expect(answer.outcome).toMatchObject({ kind: 'error', source: 'local', error: { error: { message: expect.stringContaining('session ended') } } });
    expect(state.accounts[0]!.state).toBe('session_terminated');
    expect(fetcher).toHaveBeenCalledOnce();
    await readResponses(fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('a renewable 401 retries once and preserves the second upstream response', async () => {
    const last = { error: { code: 'expired_token', message: 'Still expired' } };
    const fetcher = vi.fn<Fetcher>()
      .mockResolvedValueOnce(Response.json({ error: { code: 'expired_token', message: 'Expired' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ access_token: 'retried', refresh_token: 'rotated', expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json(last, { status: 401, headers: { 'x-upstream-marker': 'kept' } }));
    const answer = await readResponses(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(answer.http?.status).toBe(401);
    expect(getHeader(answer.http!.headers, 'x-upstream-marker')).toBe('kept');
    expect(answer.outcome).toEqual({ kind: 'error', source: 'upstream', error: last });
    expect(state.accounts[0]).toMatchObject({ refresh_token: 'rotated' });
  });

  test('Responses replaces only the observed quota family and clears the cached restriction after success', async () => {
    const until = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
    const unrelated = { fetchedAt: 1, data: { observed_at: '2026-06-05T00:00:00Z', active_limit: 'other', primary_used_percent: 100, ratelimited_until: until } };
    state.accounts[0]!.quotaSnapshot = { other: unrelated };
    const rated = await readResponses(async () => Response.json({ error: { message: 'rate limited' } }, {
      status: 429,
      headers: { 'x-codex-active-limit': 'premium', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-after-seconds': '3600' },
    }));
    expect(rated.http?.status).toBe(429);
    const premium = state.accounts[0]!.quotaSnapshot.premium!;
    expect(premium.data.ratelimited_until).toBe(new Date(Date.parse(premium.data.observed_at) + 3600000).toISOString());
    await readResponses(async () => codexEvents([], { 'x-codex-active-limit': 'premium', 'x-codex-primary-used-percent': '42' }));
    expect(state.accounts[0]!.quotaSnapshot).toMatchObject({ other: unrelated, premium: { data: { primary_used_percent: 42 } } });
    expect(state.accounts[0]!.quotaSnapshot.premium!.data.ratelimited_until).toBeUndefined();
  });

  test('alpha-search preserves a JSON error and the upstream head', async () => {
    const options = host(async (url, init) => {
      expect(url).toBe('https://chatgpt.com/backend-api/codex/alpha/search');
      expect(JSON.parse(init!.body as string)).toMatchObject({ model: model.id, id: 'search', query: 'hello' });
      expect(new Headers(init!.headers).get('session-id')).toBe('search');
      return Response.json({ detail: 'Too many calls' }, { status: 429, headers: { 'x-codex-primary-used-percent': '45' } });
    });
    const running = run(asEntry(chatgptPipelines.alphaSearch), {
      http: callerHttp, upstream, model, alphaSearch: { id: ' search ', query: 'hello' },
    }, options);
    const answer = await running.result;
    expect(answer).toEqual({
      http: { status: 429, statusText: '', body: null, headers: expect.arrayContaining([['x-codex-primary-used-percent', '45']]), startedAt: expect.any(Number) },
      alphaSearch: { kind: 'error', source: 'upstream', error: { detail: 'Too many calls' } },
    });
    running.discard(answer);
    await Promise.all(options.detached);
    expect(state.accounts[0]!.quotaSnapshot).toMatchObject({ unknown: { data: { primary_used_percent: 45 } } });
  });

  test('images use the current token plan and encode uploads as Codex JSON', async () => {
    const transport = vi.fn<Fetcher>(async (url, init) => {
      expect(url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
      const headers = new Headers(init!.headers);
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('originator')).toBe('caller');
      expect(headers.get('x-codex-image-turn-id')).toBe('image-turn');
      expect(JSON.parse(init!.body as string)).toEqual({
        prompt: 'Edit', model: 'gpt-image-2', images: [{ image_url: 'data:image/png;base64,AQI=' }],
      });
      return Response.json({ created: 1, data: [] });
    });
    const options = host(transport);
    const imageModel = toUpstreamModelSnapshot(stubUpstreamModel({ id: 'gpt-image-2' }));
    state.accounts[0]!.accessToken!.planType = 'free';
    const generation = run(asEntry(chatgptPipelines.openaiImagesGenerations), {
      http: callerHttp, upstream, model: imageModel, openaiImagesGenerations: { model: 'published', prompt: 'Generate' },
    }, options);
    const unavailable = await generation.result;
    expect(unavailable).toMatchObject({ http: { status: 403 }, openaiImagesGenerations: { kind: 'error', source: 'local' } });
    expect(transport).not.toHaveBeenCalled();
    generation.discard(unavailable);
    state.accounts[0]!.accessToken!.planType = 'plus';
    const edit = run(asEntry(chatgptPipelines.openaiImagesEdits), {
      http: { ...callerHttp, headers: [['originator', 'caller'], ['x-codex-image-turn-id', 'image-turn']] },
      upstream,
      model: imageModel,
      openaiImagesEdits: {
        parameters: { prompt: 'Edit' },
        images: [{ type: 'upload', file: { name: 'image.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2]) } }],
      },
    }, options);
    const edited = await edit.result;
    expect(edited.openaiImagesEdits).toEqual({ kind: 'result', result: { created: 1, data: [] } });
    edit.discard(edited);
    await Promise.all(options.detached);
  });

  test('an image 401 keeps a sibling token and gates the retry on its observed Free plan', async () => {
    const winner = { ...account.accessToken!, token: 'winner', planType: 'free' };
    const transport = vi.fn<Fetcher>(async (_url, init) => {
      expect(new Headers(init!.headers).get('authorization')).toBe('Bearer access');
      state.accounts[0]!.accessToken = winner;
      state.accounts[0]!.refresh_token = 'sibling-rotation';
      return Response.json({ error: { code: 'expired_token', message: 'Expired' } }, { status: 401 });
    });
    const generation = run(asEntry(chatgptPipelines.openaiImagesGenerations), {
      http: callerHttp, upstream, model: toUpstreamModelSnapshot(stubUpstreamModel({ id: 'gpt-image-2' })),
      openaiImagesGenerations: { model: 'published', prompt: 'Generate' },
    }, host(transport));
    const answer = await generation.result;
    expect(answer).toMatchObject({ http: { status: 403 }, openaiImagesGenerations: { kind: 'error', source: 'local' } });
    expect(transport).toHaveBeenCalledOnce();
    expect(state.accounts[0]).toMatchObject({ accessToken: winner, refresh_token: 'sibling-rotation' });
    generation.discard(answer);
  });

  test('an OAuth refresh gates the image request on the newly observed Free plan', async () => {
    state.accounts[0]!.accessToken = null;
    const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'free' } })).toString('base64url');
    const transport = vi.fn<Fetcher>(async url => {
      expect(String(url)).toContain('/oauth/token');
      return Response.json({ access_token: 'refreshed', refresh_token: 'rotated', id_token: `e30.${claims}.signature`, expires_in: 3600 });
    });
    const generation = run(asEntry(chatgptPipelines.openaiImagesGenerations), {
      http: callerHttp, upstream, model: toUpstreamModelSnapshot(stubUpstreamModel({ id: 'gpt-image-2' })),
      openaiImagesGenerations: { model: 'published', prompt: 'Generate' },
    }, host(transport));
    const answer = await generation.result;
    expect(answer).toMatchObject({ http: { status: 403 }, openaiImagesGenerations: { kind: 'error', source: 'local' } });
    expect(transport).toHaveBeenCalledOnce();
    expect(state.accounts[0]).toMatchObject({ accessToken: { token: 'refreshed', planType: 'free' }, refresh_token: 'rotated' });
    generation.discard(answer);
  });

  test('images leave recorded quota unchanged when a successful response has no quota headers', async () => {
    const quotaSnapshot = { codex: { fetchedAt: 1, data: { observed_at: '2026-01-01T00:00:00Z', active_limit: 'codex', primary_used_percent: 42 } } };
    state.accounts[0]!.quotaSnapshot = quotaSnapshot;
    const options = host(async () => Response.json({ created: 1, data: [] }));
    const generation = run(asEntry(chatgptPipelines.openaiImagesGenerations), {
      http: callerHttp, upstream, model: toUpstreamModelSnapshot(stubUpstreamModel({ id: 'gpt-image-2' })),
      openaiImagesGenerations: { model: 'published', prompt: 'Generate' },
    }, options);
    const answer = await generation.result;
    expect(answer.openaiImagesGenerations).toEqual({ kind: 'result', result: { created: 1, data: [] } });
    generation.discard(answer);
    expect(options.detached).toHaveLength(0);
    expect(state.accounts[0]!.quotaSnapshot).toEqual(quotaSnapshot);
  });

  test('an access-only 401 retains the JSON response while recording terminal state', async () => {
    state.accounts[0]!.refresh_token = null;
    const options = host(async () => Response.json(null, { status: 401, headers: { 'x-upstream-result': 'denied' } }));
    const running = run(asEntry(chatgptPipelines.openaiResponses), responses, options);
    const answer = await running.result;
    expect(answer).toEqual({
      http: { status: 401, statusText: '', body: null, headers: expect.arrayContaining([['x-upstream-result', 'denied']]), startedAt: expect.any(Number) },
      openaiResponses: { kind: 'error', source: 'upstream', error: null },
    });
    expect(options.detached).toHaveLength(1);
    await Promise.all(options.detached);
    expect(state.accounts[0]!.state).toBe('session_terminated');
    running.discard(answer);
  });

  test('an access-only 401 keeps the upstream response when the detached terminal write fails', async () => {
    state.accounts[0]!.refresh_token = null;
    const body = { error: { code: 'token_invalidated', message: 'Re-import required' } };
    const transport = vi.fn<Fetcher>(async () => Response.json(body, { status: 401, headers: { 'x-upstream-result': 'denied' } }));
    const options = host(transport);
    const failure = new Error('terminal state write failed');
    repo.saveState.mockRejectedValueOnce(failure);
    const observed: Promise<unknown>[] = [];
    options.waitUntil = work => { observed.push(work.catch((cause: unknown) => cause)); };
    const running = run(asEntry(chatgptPipelines.openaiResponses), responses, options);
    const answer = await running.result;
    expect(answer.http?.status).toBe(401);
    expect(getHeader(answer.http!.headers, 'x-upstream-result')).toBe('denied');
    expect(answer.openaiResponses).toEqual({ kind: 'error', source: 'upstream', error: body });
    expect(transport).toHaveBeenCalledOnce();
    expect(observed).toHaveLength(1);
    expect(await observed[0]).toBe(failure);
    running.discard(answer);
  });

  test('host observation receives the original quota persistence failure independently of the answer', async () => {
    const failure = new Error('quota storage unavailable');
    const options = host(async (url, init) => {
      expect(url).toBe('https://chatgpt.com/backend-api/codex/alpha/search');
      expect(Object.fromEntries(new Headers(init!.headers))).toMatchObject({
        authorization: 'Bearer access', 'chatgpt-account-id': 'account', 'session-id': 'search-session',
        'x-codex-turn-metadata': '{"turn_id":"caller-turn","session_id":"socket-session"}',
      });
      expect(JSON.parse(init!.body as string)).toEqual({ model: model.id, id: 'search-session', commands: { search_query: [{ q: 'Floway' }] } });
      return new Response('search-result');
    });
    options.services.chatgpt.observeQuota = async () => { throw failure; };
    const observed: Promise<unknown>[] = [];
    options.waitUntil = work => { observed.push(work.catch((cause: unknown) => cause)); };
    const running = run(asEntry(chatgptPipelines.alphaSearch), {
      http: callerHttp, upstream, model, alphaSearch: { id: 'search-session', commands: { search_query: [{ q: 'Floway' }] } },
    }, options);
    const answer = await running.result;
    expect(answer.alphaSearch).toEqual({ kind: 'result', result: new TextEncoder().encode('search-result') });
    expect(await Promise.all(observed)).toEqual([failure]);
    running.discard(answer);
  });

  test('a 401 over the error body budget fails loudly before a retry', async () => {
    const body = 'a'.repeat(1024 * 1024 + 1);
    const transport = vi.fn<Fetcher>(async () => new Response(body, { status: 401 }));
    const options = host(transport);
    const running = run(asEntry(chatgptPipelines.openaiResponses), responses, options);
    await expect(running.result).rejects.toThrow(new RangeError('ChatGPT 401 response exceeds 1 MiB'));
    expect(transport).toHaveBeenCalledOnce();
    await Promise.all(options.detached);
  });

  test('preheader transport, cancellation and arbitrary throws remain distinct', async () => {
    const rootCause = new Error('socket reset');
    const failure = new HttpTransportError(new Error('network', { cause: rootCause }));
    const network = run(asEntry(chatgptPipelines.openaiResponses), responses, host(async () => { throw failure; }));
    const unavailable = await network.result;
    expect(unavailable).toMatchObject({
      http: null,
      openaiResponses: {
        kind: 'error', source: 'upstream', error: {
          error: {
            type: 'api_error', message: 'network', provider_specific_fields: {
              name: 'HttpTransportError', stack: failure.stack, cause: { message: 'network', cause: { message: 'socket reset', stack: rootCause.stack } },
            },
          },
        },
      },
    });
    network.discard(unavailable);

    const transport = vi.fn<Fetcher>();
    const cancelled = run(asEntry(chatgptPipelines.openaiResponses), responses, host(transport, AbortSignal.abort(new Error('left'))));
    const local = await cancelled.result;
    expect(local).toMatchObject({ http: null, openaiResponses: { kind: 'error', source: 'local', error: { error: { message: 'Upstream request cancelled' } } } });
    expect(transport).not.toHaveBeenCalled();
    cancelled.discard(local);

    const panic = new Error('unexpected provider failure');
    const broken = run(asEntry(chatgptPipelines.openaiResponses), responses, host(async () => { throw panic; }));
    await expect(broken.result).rejects.toBe(panic);
  });
});
