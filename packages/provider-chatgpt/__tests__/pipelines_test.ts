import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from './upstream-state-repo.ts';
import { createChatGPTProvider } from '../src/provider.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTQuotaSnapshotEntryMap, ChatGPTUpstreamState } from '../src/state.ts';
import { createDumpEncoder, runPipeline, type RawRunEvent, type RunTraceSink } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { initProviderRepo, readManagedBytes, toProviderModelFacts, type Fetcher, type Provider, type ProviderModelFacts, type ProviderPipelineAlphaSearchInput, type ProviderPipelineOpenAIImagesEditsInput, type ProviderPipelineOpenAIImagesGenerationsInput, type ProviderPipelineOpenAIResponsesInput, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const upstreamId = 'up_chatgpt_pipeline';
const accountId = 'acc';
const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

const accessToken = (overrides: Partial<ChatGPTAccessTokenEntry> = {}): ChatGPTAccessTokenEntry => ({
  token: 'at_fresh',
  expiresAt: farFutureMs,
  refreshedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const makeRecord = (state: ChatGPTUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'chatgpt',
  name: 'ChatGPT pipeline',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: accountId, chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

const activeState = (token: ChatGPTAccessTokenEntry | null = accessToken(), quotaSnapshot: ChatGPTQuotaSnapshotEntryMap | null = null): ChatGPTUpstreamState => ({
  accounts: [
    {
      chatgptAccountId: accountId,
      refresh_token: 'rt_v1',
      state: 'active',
      state_updated_at: '2026-01-01T00:00:00.000Z',
      openaiDeviceId: '11111111-2222-4333-8444-555555555555',
      accessToken: token,
      quotaSnapshot,
    },
  ],
});
let current: UpstreamRecord;
let repo: UpstreamStateRepoStub;

const services = (fetcher: Fetcher) => ({ fetcherFor: () => fetcher });
const provider = (): Provider => createChatGPTProvider(current);
const model = (overrides: { readonly id?: string; readonly providerData?: unknown; readonly limits?: ProviderModelFacts['limits'] } = {}): ProviderModelFacts => toProviderModelFacts(stubProviderModel({
  id: overrides.id ?? 'gpt-5.4',
  upstreamModelId: overrides.id ?? 'gpt-5.4',
  limits: overrides.limits ?? {},
  endpoints: { openaiResponses: {} },
  providerData: overrides.providerData ?? { contextWindow: 272000, useResponsesLite: false },
}));

const readBody = async (init: Parameters<Fetcher>[1]): Promise<Record<string, unknown>> => {
  const body = init.body as { open: () => ReadableStream<Uint8Array> };
  return await new Response(body.open()).json() as Record<string, unknown>;
};

const responsesInput = (payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: 'generate' | 'compact' = 'generate'): ProviderPipelineOpenAIResponsesInput => ({
  'provider.model': model(),
  'request.inboundHeaders': [],
  'request.action': action,
  'request.payload': payload,
});

const sse = (events: Record<string, unknown>[], headers: Record<string, string> = {}): Response => new Response(
  `${events.map(event => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } },
);

const responseBody = (output: unknown[] = [], modelId = 'gpt-5.4') => ({
  id: 'resp_1', object: 'response', model: modelId, status: 'completed', output,
  error: null, incomplete_details: null,
});

const drain = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const idToken = (plan: string) => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: plan } })).toString('base64url'),
  Buffer.from('sig').toString('base64url'),
].join('.');

const oauthResponse = (plan = 'plus', at = 'at_rotated', rt = 'rt_v2'): Response => Response.json({
  access_token: at,
  refresh_token: rt,
  expires_in: 3600,
  id_token: idToken(plan),
});

const oauthResponseWithoutPlan = (at = 'at_rotated', rt = 'rt_v2'): Response => Response.json({
  access_token: at,
  refresh_token: rt,
  expires_in: 3600,
});

const jsonError = (status: number, code: string, message: string): Response => Response.json({ error: { code, message } }, { status });

const readOutcomeBody = async (body: AsyncIterable<Uint8Array> | null): Promise<Record<string, unknown>> => {
  if (body === null) throw new Error('expected an HTTP body');
  const stream = body as Parameters<typeof readManagedBytes>[0];
  return JSON.parse(new TextDecoder().decode(await readManagedBytes(stream))) as Record<string, unknown>;
};

beforeEach(() => {
  current = makeRecord(activeState());
  repo = createUpstreamStateRepoStub(() => current, state => {
    current = { ...current, state: state as ChatGPTUpstreamState };
  });
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

describe('ChatGPT pipelines', () => {
  test('generate applies default instructions, strips unsupported fields, synthesizes SSE metadata and persists quota', async () => {
    const quotaWrites: Promise<unknown>[] = [];
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const fetcher = vi.fn(async (_url: string, init: Parameters<Fetcher>[1]) => {
      headers = new Headers(init.headers);
      body = await readBody(init);
      const upstream = sse([{ type: 'response.completed', response: responseBody() }], {
        'x-codex-active-limit': 'premium',
        'x-codex-primary-used-percent': '42',
      });
      upstream.headers.delete('content-type');
      return upstream;
    });
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      temperature: 0.2,
      reasoning: { effort: 'medium' },
      service_tier: 'priority',
    }), { services: services(fetcher), waitUntil: promise => quotaWrites.push(promise) });
    expect(result).toMatchObject({ action: 'generate', ok: true, modelKey: 'gpt-5.4' });
    expect(body).toMatchObject({ instructions: "You're a helpful assistant.", reasoning: { effort: 'medium' }, service_tier: 'priority', stream: true, store: false });
    expect(body).not.toHaveProperty('temperature');
    expect(headers?.get('authorization')).toBe('Bearer at_fresh');
    expect(headers?.get('accept')).toBe('text/event-stream');
    if (!result.ok || result.action !== 'generate') throw new Error('expected successful Responses stream');
    expect(result.http.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1]).toBe('text/event-stream');
    const frames = await drain(result.events);
    expect(frames.some(frame => frame.type === 'event' && frame.event.type === 'response.completed')).toBe(true);
    expect(frames.at(-1)).toEqual({ type: 'done' });
    expect(quotaWrites.length).toBeGreaterThan(0);
    await Promise.all(quotaWrites);
    expect((current.state as ChatGPTUpstreamState).accounts[0].quotaSnapshot?.premium.data.primary_used_percent).toBe(42);
  });

  test('inbound session_id is consumed as identity and never copied onto the wire', async () => {
    current = makeRecord(activeState(accessToken({ token: 'at_headers' })));
    let headers: Headers | undefined;
    const result = await runPipeline(provider().pipelines!.openaiResponses!, {
      ...responsesInput({ input: [] }),
      'request.inboundHeaders': [
        ['session_id', 'underscore-session'],
        ['thread-id', 'thread-header'],
        ['x-client-request-id', 'client-request'],
        ['x-codex-window-id', 'thread-header:4'],
        ['x-codex-turn-metadata', '{"turn_id":"turn-header"}'],
        ['originator', 'caller-originator'],
        ['user-agent', 'caller-agent'],
        ['x-arbitrary-client-header', 'must-not-forward'],
      ],
    }, {
      services: services(async (_url, init) => {
        headers = new Headers(init.headers);
        return sse([{ type: 'response.completed', response: responseBody() }]);
      }),
    });
    expect(result).toMatchObject({ action: 'generate', ok: true });
    expect(headers?.get('session-id')).toBe('underscore-session');
    expect(headers?.get('thread-id')).toBe('thread-header');
    expect(headers?.get('x-client-request-id')).toBe('client-request');
    expect(headers?.get('x-codex-window-id')).toBe('thread-header:4');
    expect(headers?.get('originator')).toBe('codex_cli_rs');
    expect(headers?.get('user-agent')).not.toBe('caller-agent');
    expect(headers?.has('session_id')).toBe(false);
    expect(headers?.has('x-arbitrary-client-header')).toBe(false);
  });

  test('compact returns parsed result after stripping unsupported fields', async () => {
    let body: Record<string, unknown> | undefined;
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({
      input: [{ type: 'message', role: 'user', content: 'compact' }],
      temperature: 0.3,
      reasoning: { effort: 'high' },
    }, 'compact'), {
      services: services(async (_url, init) => {
        body = await readBody(init);
        return Response.json({ id: 'cmp', object: 'response.compaction', output: [] });
      }),
    });
    expect(result).toMatchObject({ action: 'compact', ok: true, result: { id: 'cmp' } });
    expect(body).toMatchObject({ model: 'gpt-5.4', input: [{ type: 'message', role: 'user', content: 'compact' }], reasoning: { effort: 'high' } });
    expect(body).not.toHaveProperty('temperature');
  });

  test('401 drains once, refreshes the token and retries without StreamLeakError', async () => {
    const calls: Headers[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/oauth/token')) {
        return oauthResponse();
      }
      calls.push(new Headers(init?.headers));
      if (calls.length === 1) return new Response(JSON.stringify({ error: { code: 'expired_token', message: 'expired' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      return sse([{ type: 'response.completed', response: responseBody() }]);
    });
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({ input: [] }), {
      services: services(async (url, init) => await fetchSpy(url, init as RequestInit)),
    });
    expect(result).toMatchObject({ action: 'generate', ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.get('authorization')).toBe('Bearer at_fresh');
    expect(calls[1]?.get('authorization')).toBe('Bearer at_rotated');
    if (!result.ok || result.action !== 'generate') throw new Error('expected successful retry');
    await drain(result.events);
    expect((current.state as ChatGPTUpstreamState).accounts[0].refresh_token).toBe('rt_v2');
  });

  test('401 retry preserves the exact Codex header set without copying raw inbound headers', async () => {
    const calls: Headers[] = [];
    const result = await runPipeline(provider().pipelines!.openaiResponses!, {
      ...responsesInput({ input: [] }),
      'request.inboundHeaders': [
        ['session_id', 'stable-session'],
        ['x-arbitrary', 'not-on-wire'],
        ['user-agent', 'not-on-wire'],
      ],
    }, {
      services: services(async (url, init) => {
        if (url.includes('/oauth/token')) return oauthResponse();
        calls.push(new Headers(init.headers));
        return calls.length === 1
          ? jsonError(401, 'expired_token', 'expired')
          : sse([{ type: 'response.completed', response: responseBody() }]);
      }),
    });
    expect(result).toMatchObject({ action: 'generate', ok: true });
    expect(calls).toHaveLength(2);
    for (const headers of calls) {
      expect(headers.get('session-id')).toBe('stable-session');
      expect(headers.has('session_id')).toBe(false);
      expect(headers.has('x-arbitrary')).toBe(false);
      expect(headers.get('user-agent')).not.toBe('not-on-wire');
      expect(headers.get('content-type')).toBe('application/json');
      expect(headers.get('accept')).toBe('text/event-stream');
      expect(headers.get('x-codex-window-id')).toBe('stable-session:0');
    }
  });

  test('token_invalidated returns synthetic 503 and terminates the session', async () => {
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({ input: [] }), {
      services: services(async () => jsonError(401, 'token_invalidated', 'session ended')),
    });
    expect(result).toMatchObject({ action: 'generate', ok: false, http: { status: 503 } });
    const account = (current.state as ChatGPTUpstreamState).accounts[0];
    expect(account.state).toBe('session_terminated');
    expect(account.state_message).toContain('session ended');
  });

  test('second 401 token_invalidated returns synthetic 503 and terminates the session', async () => {
    let calls = 0;
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({ input: [] }), {
      services: services(async url => {
        if (url.includes('/oauth/token')) return oauthResponse();
        calls++;
        return calls === 1
          ? jsonError(401, 'expired_token', 'expired')
          : jsonError(401, 'token_invalidated', 'second session ended');
      }),
    });
    expect(result).toMatchObject({ action: 'generate', ok: false, http: { status: 503 } });
    expect((current.state as ChatGPTUpstreamState).accounts[0].state).toBe('session_terminated');
    expect((current.state as ChatGPTUpstreamState).accounts[0].state_message).toContain('second session ended');
  });

  test('401 refresh without a JWT plan inherits the failed token plan observation', async () => {
    current = makeRecord(activeState(accessToken({
      token: 'at_fresh',
      planType: 'plus',
      planObservedAt: '2026-01-01T00:00:00.000Z',
    })));
    let calls = 0;
    const result = await runPipeline(provider().pipelines!.openaiImagesGenerations!, {
      'provider.model': model({ id: 'gpt-image-2' }),
      'request.inboundHeaders': [],
      'request.payload': { prompt: 'draw' },
    }, {
      services: services(async url => {
        if (url.includes('/oauth/token')) return oauthResponseWithoutPlan();
        calls++;
        return calls === 1 ? jsonError(401, 'expired_token', 'expired') : Response.json({ created: 1, data: [] });
      }),
    });
    expect(result).toMatchObject({ status: 200, modelKey: 'gpt-image-2' });
    expect(calls).toBe(2);
    expect((current.state as ChatGPTUpstreamState).accounts[0].accessToken).toMatchObject({
      token: 'at_rotated',
      planType: 'plus',
    });
    expect((current.state as ChatGPTUpstreamState).accounts[0].accessToken?.planObservedAt).toEqual(expect.any(String));
  });

  test('access-only 401 preserves the upstream 401 and body', async () => {
    current = makeRecord({
      accounts: [{
        ...activeState(accessToken({ expiresAt: null })).accounts[0],
        refresh_token: null,
      }],
    });
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({ input: [] }), {
      services: services(async () => jsonError(401, 'expired_token', 're-import required')),
    });
    expect(result).toMatchObject({ action: 'generate', ok: false, http: { status: 401 } });
    if (result.ok) throw new Error('expected upstream 401');
    expect(await readOutcomeBody(result.http.body)).toEqual({ error: { code: 'expired_token', message: 're-import required' } });
    expect((current.state as ChatGPTUpstreamState).accounts[0].state).toBe('session_terminated');
  });

  test('double 401 returns the second upstream response verbatim', async () => {
    let calls = 0;
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({ input: [] }), {
      services: services(async url => {
        if (url.includes('/oauth/token')) return oauthResponse();
        calls++;
        return jsonError(401, 'expired_token', calls === 1 ? 'first' : 'second');
      }),
    });
    expect(result).toMatchObject({ action: 'generate', ok: false, http: { status: 401 } });
    if (result.ok) throw new Error('expected second 401');
    expect(await readOutcomeBody(result.http.body)).toEqual({ error: { code: 'expired_token', message: 'second' } });
    expect(calls).toBe(2);
  });

  test('Responses Lite moves fields on the wire and restores them in terminal events', async () => {
    current = makeRecord(activeState(accessToken({ token: 'at_lite' })));
    let wire: Record<string, unknown> | undefined;
    const liteModel = model({ providerData: { contextWindow: 272000, useResponsesLite: true } });
    const input = {
      ...responsesInput({
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        instructions: 'Base instructions',
        tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
      }),
      'provider.model': liteModel,
    } satisfies ProviderPipelineOpenAIResponsesInput;
    const item = {
      type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'answer', annotations: [] }],
    };
    const result = await runPipeline(provider().pipelines!.openaiResponses!, input, {
      services: services(async (_url, init) => {
        wire = await readBody(init);
        return sse([
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { ...responseBody(), instructions: null, tools: [] } },
        ]);
      }),
    });
    expect(wire).not.toHaveProperty('instructions');
    expect(wire).not.toHaveProperty('tools');
    expect(wire?.parallel_tool_calls).toBe(false);
    expect(wire?.reasoning).toEqual({ context: 'all_turns' });
    if (!result.ok || result.action !== 'generate') throw new Error('expected Lite stream');
    const frames = await drain(result.events);
    const terminal = frames.find(frame => frame.type === 'event' && frame.event.type === 'response.completed');
    expect(terminal).toMatchObject({ event: { response: { instructions: 'Base instructions', tools: input['request.payload'].tools, output: [item] } } });
  });

  test('alphaSearch injects a request id and uses Codex authorization', async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const input: ProviderPipelineAlphaSearchInput = {
      'provider.model': model(),
      'request.inboundHeaders': [['x-codex-turn-metadata', '{"turn_id":"turn-1"}']],
      'request.payload': { commands: { search_query: [{ q: 'Floway' }] } },
    };
    const result = await runPipeline(provider().pipelines!.alphaSearch!, input, {
      services: services(async (_url, init) => {
        headers = new Headers(init.headers);
        body = await readBody(init);
        return Response.json({ output: 'found' });
      }),
    });
    expect(result).toMatchObject({ status: 200, modelKey: 'gpt-5.4' });
    expect(body).toMatchObject({ model: 'gpt-5.4', id: expect.stringMatching(/^[0-9a-f-]{36}$/), commands: { search_query: [{ q: 'Floway' }] } });
    expect(headers?.get('session-id')).toBe(headers?.get('thread-id'));
    expect(headers?.get('x-codex-turn-metadata')).toBe('{"turn_id":"turn-1"}');
    expect(headers?.has('session_id')).toBe(false);
  });

  test('alphaSearch uses the body request id for identity and only copies turn metadata from inbound headers', async () => {
    let headers: Headers | undefined;
    await runPipeline(provider().pipelines!.alphaSearch!, {
      'provider.model': model(),
      'request.inboundHeaders': [
        ['session_id', 'header-session'],
        ['thread-id', 'header-thread'],
        ['x-client-request-id', 'header-client'],
        ['x-codex-window-id', 'header-thread:7'],
      ],
      'request.payload': { id: 'body-request-id', commands: {} },
    }, {
      services: services(async (_url, init) => {
        headers = new Headers(init.headers);
        return Response.json({ output: 'found' });
      }),
    });
    expect(headers?.get('session-id')).toBe('body-request-id');
    expect(headers?.get('thread-id')).toBe('body-request-id');
    expect(headers?.get('x-client-request-id')).toBe('body-request-id');
    expect(headers?.get('x-codex-window-id')).toBe('body-request-id:0');
    expect(headers?.has('session_id')).toBe(false);
  });

  test('alphaSearch retries a 401 with the refreshed access token', async () => {
    const auth: string[] = [];
    const result = await runPipeline(provider().pipelines!.alphaSearch!, {
      'provider.model': model(),
      'request.inboundHeaders': [],
      'request.payload': { commands: { search_query: [{ q: 'Floway' }] } },
    }, {
      services: services(async (url, init) => {
        if (url.includes('/oauth/token')) return oauthResponse();
        auth.push(new Headers(init.headers).get('authorization') ?? '');
        return auth.length === 1 ? jsonError(401, 'expired_token', 'expired') : Response.json({ output: 'found' });
      }),
    });
    expect(result.status).toBe(200);
    expect(auth).toEqual(['Bearer at_fresh', 'Bearer at_rotated']);
  });

  test('images generations gate free plans before any upstream image call', async () => {
    current = makeRecord(activeState(accessToken({ planType: 'free' })));
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/oauth/token')) throw new Error('must not refresh a fresh token');
      throw new Error('must not dispatch image request');
    });
    const input: ProviderPipelineOpenAIImagesGenerationsInput = {
      'provider.model': model({ id: 'gpt-image-2' }),
      'request.inboundHeaders': [],
      'request.payload': { prompt: 'draw' },
    };
    const result = await runPipeline(provider().pipelines!.openaiImagesGenerations!, input, { services: services(fetcher) });
    expect(result).toMatchObject({ status: 403, modelKey: 'gpt-image-2' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each(['openaiImagesGenerations', 'openaiImagesEdits'] as const)('%s dispatches the JSON request with Codex image headers', async operation => {
    let url = '';
    let headers: Headers | undefined;
    let body: Record<string, unknown> | undefined;
    const base = {
      'provider.model': model({ id: 'gpt-image-2' }),
      'request.inboundHeaders': [['originator', 'downstream-originator'], ['x-codex-image-turn-id', 'image-turn']] as const,
    };
    const input = operation === 'openaiImagesGenerations'
      ? { ...base, 'request.payload': { prompt: 'draw' } } satisfies ProviderPipelineOpenAIImagesGenerationsInput
      : { ...base, 'request.payload': { images: [{ type: 'inline' as const, reference: { image_url: 'data:image/png;base64,aQ==' } }], parameters: { prompt: 'edit' } } } satisfies ProviderPipelineOpenAIImagesEditsInput;
    const result = operation === 'openaiImagesGenerations'
      ? await runPipeline(provider().pipelines!.openaiImagesGenerations!, input as ProviderPipelineOpenAIImagesGenerationsInput, {
          services: services(async (requestUrl, init) => {
            url = requestUrl;
            headers = new Headers(init.headers);
            body = await readBody(init);
            return Response.json({ created: 1, data: [] });
          }),
        })
      : await runPipeline(provider().pipelines!.openaiImagesEdits!, input as ProviderPipelineOpenAIImagesEditsInput, {
          services: services(async (requestUrl, init) => {
            url = requestUrl;
            headers = new Headers(init.headers);
            body = await readBody(init);
            return Response.json({ created: 1, data: [] });
          }),
        });
    expect(result.status).toBe(200);
    expect(url).toContain(operation === 'openaiImagesGenerations' ? '/codex/images/generations' : '/codex/images/edits');
    expect(headers?.get('authorization')).toBe('Bearer at_fresh');
    expect(headers?.get('originator')).toBe('downstream-originator');
    expect(headers?.get('x-codex-image-turn-id')).toBe('image-turn');
    if (operation === 'openaiImagesGenerations') expect(body).toEqual({ prompt: 'draw', model: 'gpt-image-2' });
    else expect(body).toEqual({ prompt: 'edit', images: [{ image_url: 'data:image/png;base64,aQ==' }], model: 'gpt-image-2' });
  });

  test.each(['openaiImagesGenerations', 'openaiImagesEdits'] as const)('%s re-checks plan after a 401 refresh and skips dispatch on downgrade', async operation => {
    let calls = 0;
    const fetcher = async (url: string) => {
      if (url.includes('/oauth/token')) return oauthResponse('free', 'at_free');
      calls++;
      return jsonError(401, 'expired_token', 'expired');
    };
    const base = {
      'provider.model': model({ id: 'gpt-image-2' }),
      'request.inboundHeaders': [],
    };
    const input = operation === 'openaiImagesGenerations'
      ? { ...base, 'request.payload': { prompt: 'draw' } } satisfies ProviderPipelineOpenAIImagesGenerationsInput
      : { ...base, 'request.payload': { images: [{ type: 'inline' as const, reference: { image_url: 'data:image/png;base64,aQ==' } }], parameters: { prompt: 'edit' } } } satisfies ProviderPipelineOpenAIImagesEditsInput;
    const result = operation === 'openaiImagesGenerations'
      ? await runPipeline(provider().pipelines!.openaiImagesGenerations!, input as ProviderPipelineOpenAIImagesGenerationsInput, { services: services(fetcher) })
      : await runPipeline(provider().pipelines!.openaiImagesEdits!, input as ProviderPipelineOpenAIImagesEditsInput, { services: services(fetcher) });
    expect(result).toMatchObject({ status: 403, modelKey: 'gpt-image-2' });
    expect(calls).toBe(1);
  });

  test('dump encoding never exposes OAuth access or refresh tokens', async () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: true });
    const encoded: unknown[] = [];
    let encodedRequests = 0;
    const traceSink: RunTraceSink = {
      push: (event: RawRunEvent) => { encoded.push(...encoder.encodeBatch([event])); },
      registerSecretPlaintext: plaintext => encoder.registerSecretPlaintext(plaintext),
    };
    const result = await runPipeline(provider().pipelines!.openaiResponses!, responsesInput({ input: [] }), {
      services: services(async url => {
        if (url.includes('/oauth/token')) return oauthResponse('plus', 'at_rotated', 'rt_v2');
        if (url.includes('/codex/responses')) {
          return encodedRequests++ === 0
            ? jsonError(401, 'expired_token', 'expired')
            : sse([{ type: 'response.completed', response: responseBody() }]);
        }
        throw new Error(`unexpected URL ${url}`);
      }),
      traceSink,
    });
    if (!result.ok || result.action !== 'generate') throw new Error('expected Responses stream');
    await drain(result.events);
    await vi.waitFor(() => expect(encoded.some(event => (event as { k?: string }).k === 'done')).toBe(true));
    const dump = JSON.stringify(encoded);
    expect(dump).not.toContain('at_fresh');
    expect(dump).not.toContain('at_rotated');
    expect(dump).not.toContain('rt_v1');
    expect(dump).not.toContain('rt_v2');
    expect(dump).toContain('$secret');
  });
});
