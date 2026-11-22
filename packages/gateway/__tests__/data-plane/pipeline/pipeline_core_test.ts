import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  GatewayRequestDirectory,
  createGatewayPipelineServices,
  createJsonPassthroughPipeline,
  encodeManagedSseStream,
  failoverRouteCandidates,
  filterInboundHeaderEntries,
  forwardedResponseHeaderEntries,
  relayedResponseHeaderEntries,
  materializeDownstreamResponse,
  retryTimeFromHeaderEntries,
  runGatewayHttpPipeline,
} from '../../../src/data-plane/pipeline/index.ts';
import type { DownstreamHttpOutcome, GatewayPipelineServices, SseOutcome, SseProtocol } from '../../../src/data-plane/pipeline/index.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import type { AuthedContext } from '../../../src/middleware/auth.ts';
import { modelsRefreshInputs } from '../../../src/repo/models-refresh-inputs.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { mockGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import {
  createDumpDecoder,
  createDumpEncoder,
  defineStage,
  pipeline,
  projectWireView,
  runPipeline,
  secret,
  terminal,
} from '@floway-dev/pipeline';
import type {
  HeaderEntry,
  ManagedStream,
  RunTraceSink,
  StageEnv,
  WireRequestSnapshot,
} from '@floway-dev/pipeline';
import { isEventStreamMediaType, type ProtocolFrame } from '@floway-dev/protocols/common';
import { readManagedBytes, toProviderModelFacts, type HttpOutcome, type RouteCandidate } from '@floway-dev/provider';
import { ProxyDialError } from '@floway-dev/proxy';
import { stubProviderModel } from '@floway-dev/test-utils';

const providerModel = (id: string, endpoints: Record<string, object> = { openaiEmbeddings: {} }) => stubProviderModel({
  id,
  upstreamModelId: id,
  kind: id.includes('image') ? 'image' : 'embedding',
  endpoints,
  providerData: id,
});

const upstreamWithModels = (
  id: string,
  models: ReturnType<typeof providerModel>[],
  overrides: Parameters<typeof buildCustomUpstreamRecord>[0] = {},
) => buildCustomUpstreamRecord({
  id,
  name: id,
  sortOrder: id.endsWith('a') ? 1 : 2,
  modelsCache: { revision: MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models, lastError: null },
  ...overrides,
});

const saveUpstreamWithModels = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  record: ReturnType<typeof upstreamWithModels>,
): Promise<void> => {
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = await repo.upstreams.getById(record.id);
  if (stored === null) throw new Error(`missing seeded upstream ${record.id}`);
  await repo.upstreams.publishModelsRefresh({
    id: stored.id,
    configVersion: stored.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(stored),
    cache: {
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: Date.now(),
      models: record.modelsCache?.models ?? [],
    },
  });
};

const routeCandidate = (id: string, upstream = `up_${id}`): RouteCandidate => Object.freeze({
  upstreamId: upstream,
  upstreamName: upstream,
  kind: 'custom',
  modelId: id,
  upstreamModelId: id,
  endpoints: { openaiEmbeddings: {} },
  limits: {},
  providerModel: toProviderModelFacts(providerModel(id)),
});

const httpOutcome = (
  status: number,
  body: ManagedStream<Uint8Array> | null,
  headers: readonly HeaderEntry[] = [],
): HttpOutcome => ({
  status,
  statusText: '',
  headers,
  body,
  timing: { startedAtMs: 1, headersAtMs: 2 },
});

const managedBytes = (
  env: StageEnv<GatewayPipelineServices>,
  text: string,
  onClose?: NonNullable<Parameters<StageEnv<GatewayPipelineServices>['createStream']>[0]['onClose']>,
): ManagedStream<Uint8Array> =>
  env.createStream({
    label: 'body',
    async *iterate() {
      yield new TextEncoder().encode(text);
    },
    ...(onClose === undefined ? {} : { onClose }),
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('GatewayRequestDirectory', () => {
  test('loads once and applies alias ordering, kind filtering, and same-rule deduplication', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await saveUpstreamWithModels(repo, upstreamWithModels('up_a', [providerModel('embed-a')], {
      modelPrefix: { prefix: 'a/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
    }));
    await saveUpstreamWithModels(repo, upstreamWithModels('up_b', [providerModel('embed-b')]));
    await repo.modelAliases.insert({
      id: 'alias_embed',
      name: 'alias-embed',
      kind: 'embedding',
      selection: 'first-available',
      targets: [
        { target_model_id: 'embed-a', rules: { verbosity: 'low' } },
        { target_model_id: 'embed-b', rules: { verbosity: 'high' } },
        { target_model_id: 'embed-a', rules: { verbosity: 'low' } },
      ],
      displayName: null,
      visibleInModelsList: true,
      announcedMetadata: null,
      sortOrder: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const list = vi.spyOn(repo.upstreams, 'list');
    const directory = new GatewayRequestDirectory({
      user: { id: 1, username: 'admin', passwordHash: null, isAdmin: true, createdAt: '1970-01-01T00:00:00.000Z', deletedAt: null },
      upstreamIds: null,
      randomizeUpstreams: false,
      runtimeLocation: 'TEST',
      backgroundScheduler: promise => { void promise; },
      wrapFetcher: fetcher => fetcher,
    });

    const alias = await directory.enumerateCandidates('alias-embed', 'embedding');
    const direct = await directory.enumerateCandidates('embed-a', 'embedding');

    expect(list).toHaveBeenCalledOnce();
    expect(alias.candidates.map(route => `${route.modelId}@${route.upstreamId}`)).toEqual(['embed-a@up_a', 'embed-b@up_b']);
    expect(alias.candidates.every(route => Object.isFrozen(route) && Object.isFrozen(route.providerModel.enabledFlags))).toBe(true);
    expect(direct.candidates).toHaveLength(1);
  });

  test('routes a pure frozen candidate through a pipeline without invalid fact values', async () => {
    const route = routeCandidate('embed-a');
    const pipe = pipeline<{ readonly 'route.candidate': RouteCandidate }>('frozen-route')
      .use(defineStage<{ readonly 'route.candidate': RouteCandidate }, Record<never, never>, string, string>({
        name: 'inspect',
        execute: async (facts, next) => {
          expect(Object.isFrozen(facts['route.candidate'])).toBe(true);
          expect(Object.isFrozen(facts['route.candidate'].providerModel.enabledFlags)).toBe(true);
          return await next();
        },
      }))
      .end(terminal<Record<never, never>, string>({ name: 'done', execute: async () => 'done' }));

    expect(await runPipeline(pipe, { 'route.candidate': route })).toBe('done');
  });
});

describe('header entries', () => {
  test('filters repeated lines case-insensitively with stateless regexes and preserves Secret values', () => {
    const regexp = /^x-test-/g;
    const authorization = secret('Bearer token');
    const headers: readonly HeaderEntry[] = Object.freeze([
      Object.freeze(['Authorization', authorization] as const),
      Object.freeze(['X-Test-One', 'a'] as const),
      Object.freeze(['x-test-one', 'b'] as const),
      Object.freeze(['other', 'c'] as const),
    ]);

    const filtered = filterInboundHeaderEntries(headers, ['authorization', regexp]);

    expect(filtered).toEqual([
      ['Authorization', authorization],
      ['X-Test-One', 'a'],
      ['x-test-one', 'b'],
    ]);
    expect(regexp.lastIndex).toBe(0);
    expect(Object.isFrozen(filtered)).toBe(true);
  });

  test('forwards each content type once, adds the default, and strips blocked fields', () => {
    const headers: readonly HeaderEntry[] = Object.freeze([
      Object.freeze(['content-type', 'text/event-stream'] as const),
      Object.freeze(['x-request-id', 'id'] as const),
      Object.freeze(['content-length', '12'] as const),
      Object.freeze(['set-cookie', 'secret'] as const),
    ]);

    expect(forwardedResponseHeaderEntries(headers, 'application/json')).toEqual([
      ['content-type', 'text/event-stream'],
      ['x-request-id', 'id'],
    ]);
    expect(forwardedResponseHeaderEntries([], 'application/json')).toEqual([['content-type', 'application/json']]);
    expect(forwardedResponseHeaderEntries([], null)).toEqual([]);
  });
});

describe('failoverRouteCandidates', () => {
  test('selects the earliest valid Retry-After and discards the superseded body', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    expect(retryTimeFromHeaderEntries([['retry-after', '2']])).toBe(Date.now() + 2_000);
    const ctx = mockGatewayCtx();
    const services = createGatewayPipelineServices(ctx);
    const closes: Array<{ readonly candidate: string; readonly how: string }> = [];
    const results = [429, 503];
    const retryAfter = ['2', undefined];
    const pipe = pipeline<Record<never, never>>('retry')
      .use(defineStage<Record<never, never>, Record<never, never>, { readonly route: RouteCandidate; readonly http: HttpOutcome }, { readonly route: RouteCandidate; readonly http: HttpOutcome }, never, GatewayPipelineServices>({
        name: 'failover',
        execute: async (_facts, _next, env) => await failoverRouteCandidates({
          candidates: [routeCandidate('one'), routeCandidate('two')],
          invocationLabel: 'retry',
          operation: 'embeddings',
          env,
          run: async route => {
            const index = route.modelId === 'one' ? 0 : 1;
            const body = managedBytes(env, String(results[index]), info => {
              closes.push({ candidate: route.modelId, how: info.how });
            });
            return { route, http: httpOutcome(results[index]!, body, retryAfter[index] === undefined ? [] : [['retry-after', retryAfter[index]!] as const]) };
          },
          inspect: result => ({
            success: false,
            headers: result.http.headers,
            discardStream: result.http.body,
          }),
        }),
      }))
      .end(terminal<Record<never, never>, { readonly route: RouteCandidate; readonly http: HttpOutcome }, GatewayPipelineServices>({
        name: 'done',
        execute: async () => ({ route: routeCandidate('done'), http: httpOutcome(500, null) }),
      }));
    const selected = await runPipeline(pipe, {}, {
      services: {
        ...services,
        attempt: ctx.attempt,
        fetcherFor: services.fetcherFor,
        providerFor: services.providerFor,
        onUpstreamDispatch: services.onUpstreamDispatch,
        directory: services.directory,
        attribution: services.attribution,
        egressState: services.egressState,
      },
    });
    await readManagedBytes(selected.http.body);

    expect(selected.route.modelId).toBe('one');
    expect(closes).toEqual([
      { candidate: 'two', how: 'discarded' },
      { candidate: 'one', how: 'exhausted' },
    ]);
    expect(ctx.attempt.telemetry?.upstream).toBe('up_two');
  });

  test('rolls over transport errors and stamps the throwing candidate before await', async () => {
    const ctx = mockGatewayCtx();
    const services = createGatewayPipelineServices(ctx);
    const env = {
      ...services,
      signal: new AbortController().signal,
      attempt: ctx.attempt,
      discard: async () => {},
      createStream: () => { throw new Error('unused'); },
    } as unknown as StageEnv<GatewayPipelineServices>;
    const error = new ProxyDialError('connection refused', 'tcp-connect');
    const seen: Array<string | undefined> = [];

    const result = await failoverRouteCandidates({
      candidates: [routeCandidate('a', 'up_a'), routeCandidate('b', 'up_b')],
      invocationLabel: 'transport',
      operation: 'embeddings',
      env,
      run: async route => {
        seen.push(ctx.attempt.telemetry?.upstream);
        if (route.modelId === 'a') throw error;
        return 'ok';
      },
      inspect: () => ({ success: true }),
    });

    expect(result).toBe('ok');
    expect(seen).toEqual(['up_a', 'up_b']);
  });

  test('discards every failed managed stream linearly under runPipeline ownership', async () => {
    const ctx = mockGatewayCtx();
    const services = createGatewayPipelineServices(ctx);
    const pipe = pipeline<Record<never, never>>('linear-discard')
      .use(defineStage<Record<never, never>, Record<never, never>, HttpOutcome, HttpOutcome, never, GatewayPipelineServices>({
        name: 'failover',
        execute: async (_facts, _next, env) => await failoverRouteCandidates({
          candidates: [routeCandidate('a'), routeCandidate('b'), routeCandidate('c')],
          invocationLabel: 'linear',
          operation: 'embeddings',
          env,
          run: async () => await Promise.resolve(httpOutcome(503, managedBytes(env, 'failed'), [['retry-after', '1']])),
          inspect: result => ({ success: false, headers: result.headers, discardStream: result.body }),
        }).then(async result => {
          await readManagedBytes(result.body);
          return result;
        }),
      }))
      .end(terminal<Record<never, never>, HttpOutcome, GatewayPipelineServices>({
        name: 'done',
        execute: async () => httpOutcome(503, null),
      }));

    await expect(runPipeline(pipe, {}, { services })).resolves.toMatchObject({ status: 503 });
  });
});

describe('passthrough pipeline', () => {
  test('reads a successful body once, bills it, forwards upstream metadata, and leaves no stream leak', async () => {
    const ctx = mockGatewayCtx();
    const store = await setupAppTest();
    const record = upstreamWithModels('up_embed', [providerModel('embed-model')]);
    await store.repo.upstreams.deleteAll();
    await saveUpstreamWithModels(store.repo, record);
    const directory = new GatewayRequestDirectory({
      user: ctx.user,
      upstreamIds: null,
      randomizeUpstreams: false,
      runtimeLocation: ctx.runtimeLocation,
      backgroundScheduler: ctx.backgroundScheduler,
    });
    await directory.ensureLoaded();
    const provider = directory.providerFor('up_embed');
    const providerServices = createGatewayPipelineServices(ctx, { directory });
    let closeCount = 0;
    const providerPipe = pipeline<{ readonly 'request.model': string }>('provider.embeddings')
      .use(defineStage<{ readonly 'request.model': string }, Record<never, never>, HttpOutcome, HttpOutcome>({
        name: 'provider.http',
        tap: 'upstream',
        execute: async (_facts, _next, env) => {
          const body = env.createStream<Uint8Array>({
            label: 'http.body',
            async *iterate() {
              yield new TextEncoder().encode(JSON.stringify({ data: [], usage: { prompt_tokens: 7 } }));
            },
            onClose: () => { closeCount++; },
          });
          return {
            status: 201,
            statusText: 'Created',
            headers: [['x-upstream-request', 'req_123']],
            modelKey: 'embed-wire',
            body,
            timing: { startedAtMs: 1, headersAtMs: 2 },
          };
        },
      }))
      .end(terminal<Record<never, never>, HttpOutcome>({ name: 'unreachable', execute: async () => httpOutcome(500, null) }));
    Object.assign(provider, { pipelines: { ...provider.pipelines, openaiEmbeddings: providerPipe } });
    const pipe = createJsonPassthroughPipeline<Record<string, unknown>, 'openaiEmbeddings'>({
      name: 'embeddings',
      sourceApi: '/embeddings',
      operation: 'embeddings',
      kind: 'embedding',
      endpointKey: 'openaiEmbeddings',
      modelServesEndpoint: route => route.endpoints.openaiEmbeddings !== undefined,
      buildProviderInput: (facts, inboundHeaders) => ({
        'provider.model': facts['route.candidate'].providerModel,
        'request.inboundHeaders': inboundHeaders,
        'request.payload': facts['request.payload'],
      }),
      extractBilling: body => ({ input: (body as { usage: { prompt_tokens: number } }).usage.prompt_tokens }),
    });
    const outcome = await runPipeline(pipe, {
      'request.http': { method: 'POST', url: 'https://gateway.example/v1/embeddings', headers: [], body: {} },
      'request.inboundHeaders': [],
      'request.model': 'embed-model',
      'request.payload': { input: 'hello' },
    }, { services: providerServices });

    expect(outcome.status).toBe(201);
    expect(outcome.statusText).toBe('Created');
    expect(outcome.headers).toContainEqual(['x-upstream-request', 'req_123']);
    expect(new TextDecoder().decode(outcome.body as Uint8Array)).toContain('prompt_tokens');
    expect(closeCount).toBe(1);
    expect(ctx.attempt.telemetry).toMatchObject({ model: 'embed-model', upstream: 'up_embed' });
  });
});

describe('SSE and downstream response', () => {
  const protocol: SseProtocol<ProtocolFrame<{ text: string }>> = {
    encode: (frame: ProtocolFrame<{ text: string }>) => frame.type === 'done'
      ? { wire: null, end: { type: 'completed' as const, trailer: ['data: trailer\n\n'] } }
      : { wire: `data: ${frame.event.text}\n\n` },
    eof: () => ({ type: 'completed' as const, trailer: ['data: trailer\n\n'] }),
    failure: (error: unknown): readonly [string, ...string[]] => [`data: ${error instanceof Error ? error.message : String(error)}\n\n`],
  };

  const runSse = async (mode: 'completed' | 'premature-eof' | 'source-error') => {
    const ctx = mockGatewayCtx();
    const services = createGatewayPipelineServices(ctx);
    const settles: SseOutcome[] = [];
    const pipe = pipeline<{ readonly 'request.http': WireRequestSnapshot }>('sse')
      .use(defineStage<{ readonly 'request.http': WireRequestSnapshot }, Record<never, never>, DownstreamHttpOutcome, DownstreamHttpOutcome, never, GatewayPipelineServices>({
        name: 'edge.downstream',
        tap: 'downstream',
        execute: async (_facts, _next, env) => {
          const source = env.createStream<ProtocolFrame<{ text: string }>>({
            label: 'protocol.events',
            async *iterate() {
              if (mode === 'source-error') throw new Error('source failed');
              yield { type: 'event', event: { text: 'hello' } };
            },
          });
          return {
            status: 200,
            headers: [['content-type', 'text/event-stream']],
            body: encodeManagedSseStream(env, source, {
              protocol: mode === 'premature-eof'
                ? { ...protocol, eof: () => ({ type: 'premature-eof' as const, error: new Error('premature') }) }
                : protocol,
              onSettle: outcome => { settles.push(outcome); },
            }),
            sse: { keepAliveIntervalMs: 60_000 },
          };
        },
      }))
      .end(terminal<{ readonly 'request.http': WireRequestSnapshot }, DownstreamHttpOutcome, GatewayPipelineServices>({
        name: 'unreachable',
        execute: async () => ({ status: 500, headers: [], body: null }),
      }));
    const app = new Hono();
    app.post('/', async c => await runGatewayHttpPipeline(c as unknown as AuthedContext, ctx, pipe, {
      'request.http': { method: 'POST', url: 'https://gateway.example/v1/stream', headers: [], body: {} },
    }, { services }));
    return { response: await app.request('/', { method: 'POST' }), settles };
  };

  test('renders a completed protocol trailer and settles once', async () => {
    const { response, settles } = await runSse('completed');
    expect(await response.text()).toBe('data: hello\n\ndata: trailer\n\n');
    expect(settles).toEqual([{ type: 'completed' }]);
  });

  test('renders premature EOF failure text and settles once', async () => {
    const { response, settles } = await runSse('premature-eof');
    expect(await response.text()).toBe('data: hello\n\ndata: premature\n\n');
    expect(settles).toEqual([{ type: 'premature-eof', error: expect.any(Error) }]);
  });

  test('renders a source error trailer and settles once', async () => {
    const { response, settles } = await runSse('source-error');
    expect(await response.text()).toBe('data: source failed\n\n');
    expect(settles).toEqual([{ type: 'source-error', error: expect.any(Error) }]);
  });

  const settleAtChunk = async (
    source: (env: StageEnv<GatewayPipelineServices>) => ManagedStream<ProtocolFrame<{ text: string }>>,
    protocolOverride: typeof protocol,
    stopAt: string,
    mutate?: (env: StageEnv<GatewayPipelineServices>) => void,
  ): Promise<readonly SseOutcome[]> => {
    const services = createGatewayPipelineServices(mockGatewayCtx());
    const outcomes: SseOutcome[] = [];
    const pipe = pipeline<Record<never, never>>('sse-cancel-at-chunk')
      .use(defineStage<Record<never, never>, Record<never, never>, ManagedStream<Uint8Array>, ManagedStream<Uint8Array>, never, GatewayPipelineServices>({
        name: 'sse',
        execute: async (_facts, _next, env) => {
          const bytes = encodeManagedSseStream(env, source(env), {
            protocol: protocolOverride,
            onSettle: outcome => { outcomes.push(outcome); },
          });
          const iterator = bytes[Symbol.asyncIterator]();
          const decoder = new TextDecoder();
          for (;;) {
            const next = await iterator.next();
            if (next.done) throw new Error('SSE source ended before the requested cancellation point');
            if (decoder.decode(next.value) === stopAt) {
              mutate?.(env);
              await iterator.return?.();
              return bytes;
            }
          }
        },
      }))
      .end(terminal<Record<never, never>, ManagedStream<Uint8Array>, GatewayPipelineServices>({
        name: 'done',
        execute: async (_facts, env) => env.createStream({ async *iterate() {} }),
      }));

    await runPipeline(pipe, {}, { services });
    return outcomes;
  };

  test('settles completed when downstream closes immediately after the final [DONE] chunk', async () => {
    const outcomes = await settleAtChunk(
      env => env.createStream<ProtocolFrame<{ text: string }>>({
        async *iterate() {
          yield { type: 'event', event: { text: 'hello' } };
          yield { type: 'done' };
        },
      }),
      {
        ...protocol,
        encode: frame => frame.type === 'done'
          ? { wire: null, end: { type: 'completed' as const, trailer: ['data: [DONE]\n\n'] } }
          : protocol.encode(frame),
      },
      'data: [DONE]\n\n',
    );

    expect(outcomes).toEqual([{ type: 'completed' }]);
  });

  test('settles completed when the terminal event carries its final bytes in wire', async () => {
    const outcomes = await settleAtChunk(
      env => env.createStream<ProtocolFrame<{ text: string }>>({
        async *iterate() {
          yield { type: 'event', event: { text: 'hello' } };
          yield { type: 'done' };
        },
      }),
      {
        ...protocol,
        encode: frame => frame.type === 'done'
          ? { wire: 'event: message_stop\n\n', end: { type: 'completed' as const } }
          : protocol.encode(frame),
      },
      'event: message_stop\n\n',
    );

    expect(outcomes).toEqual([{ type: 'completed' }]);
  });

  test('settles cancelled when downstream closes after an event before its trailing [DONE] chunk', async () => {
    const outcomes = await settleAtChunk(
      env => env.createStream<ProtocolFrame<{ text: string }>>({
        async *iterate() {
          yield { type: 'event', event: { text: 'hello' } };
          yield { type: 'done' };
        },
      }),
      {
        ...protocol,
        encode: frame => frame.type === 'done'
          ? { wire: null, end: { type: 'completed' as const, trailer: ['data: [DONE]\n\n'] } }
          : protocol.encode(frame),
      },
      'data: hello\n\n',
    );

    expect(outcomes).toEqual([{ type: 'cancelled' }]);
  });

  test('settles egress-error when the egress failure is set while yielding the final chunk', async () => {
    const egressError = new Error('downstream write failed');
    const outcomes = await settleAtChunk(
      env => env.createStream<ProtocolFrame<{ text: string }>>({
        async *iterate() {
          yield { type: 'event', event: { text: 'hello' } };
          yield { type: 'done' };
        },
      }),
      {
        ...protocol,
        encode: frame => frame.type === 'done'
          ? { wire: null, end: { type: 'completed' as const, trailer: ['data: [DONE]\n\n'] } }
          : protocol.encode(frame),
      },
      'data: [DONE]\n\n',
      env => { env.egressState.error = egressError; },
    );

    expect(outcomes).toEqual([{ type: 'egress-error', error: egressError }]);
  });

  test('settles cancellation at most once when downstream closes before a frame', async () => {
    const services = createGatewayPipelineServices(mockGatewayCtx());
    const outcomes: SseOutcome[] = [];
    const pipe = pipeline<Record<never, never>>('cancel')
      .use(defineStage<Record<never, never>, Record<never, never>, ManagedStream<Uint8Array>, ManagedStream<Uint8Array>, never, GatewayPipelineServices>({
        name: 'sse',
        execute: async (_facts, _next, env) => {
          const source = env.createStream<ProtocolFrame<{ text: string }>>({ async *iterate() { await new Promise(() => {}); } });
          const bytes = encodeManagedSseStream(env, source, { protocol, onSettle: outcome => { outcomes.push(outcome); } });
          const iterator = bytes[Symbol.asyncIterator]();
          await iterator.return?.();
          return bytes;
        },
      }))
      .end(terminal<Record<never, never>, ManagedStream<Uint8Array>, GatewayPipelineServices>({
        name: 'done',
        execute: async (_facts, env) => env.createStream({ async *iterate() {} }),
      }));

    await runPipeline(pipe, {}, { services });
    expect(outcomes).toEqual([{ type: 'cancelled' }]);
  });

  test('settles an aborted source as cancelled even when its iterator resolves done', async () => {
    const controller = new AbortController();
    const services = createGatewayPipelineServices(mockGatewayCtx({ abortSignal: controller.signal }));
    const outcomes: SseOutcome[] = [];
    const pipe = pipeline<Record<never, never>>('cancel-aborted')
      .use(defineStage<Record<never, never>, Record<never, never>, ManagedStream<Uint8Array>, ManagedStream<Uint8Array>, never, GatewayPipelineServices>({
        name: 'sse',
        execute: async (_facts, _next, env) => {
          const source = env.createStream<ProtocolFrame<{ text: string }>>({
            async *iterate() {
              controller.abort(new Error('client cancelled'));
            },
          });
          return encodeManagedSseStream(env, source, { protocol, onSettle: outcome => { outcomes.push(outcome); } });
        },
      }))
      .end(terminal<Record<never, never>, ManagedStream<Uint8Array>, GatewayPipelineServices>({
        name: 'done',
        execute: async (_facts, env) => env.createStream({ async *iterate() {} }),
      }));

    const body = await runPipeline(pipe, {}, { services, signal: controller.signal });
    await expect(readManagedBytes(body)).resolves.toEqual(new Uint8Array());
    expect(outcomes).toEqual([{ type: 'cancelled' }]);
  });

  test('returns ordinary buffered outcomes through Response', async () => {
    const services = createGatewayPipelineServices(mockGatewayCtx());
    const app = new Hono();
    app.get('/', c => materializeDownstreamResponse(c, services, {
      status: 202,
      statusText: 'Accepted',
      headers: [['x-test', 'yes']],
      body: new TextEncoder().encode('hello'),
    }));
    const response = await app.request('/');
    expect(response.status).toBe(202);
    expect(response.statusText).toBe('Accepted');
    expect(response.headers.get('x-test')).toBe('yes');
    expect(await response.text()).toBe('hello');
  });
});

describe('dump projection', () => {
  test('projects both downstream request and response through Dump V2', async () => {
    const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
    const chunks: Uint8Array[] = [];
    const sink: RunTraceSink = {
      push: event => {
        for (const encoded of encoder.encodeBatch([event])) chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`));
      },
    };
    const pipe = pipeline<{ readonly 'request.http': WireRequestSnapshot }>('dump')
      .use(defineStage<{ readonly 'request.http': WireRequestSnapshot }, Record<never, never>, DownstreamHttpOutcome, DownstreamHttpOutcome, never, GatewayPipelineServices>({
        name: 'edge.downstream',
        tap: 'downstream',
        execute: async (_facts, _next, env) => ({ status: 200, headers: [], body: new TextEncoder().encode(env.apiKeyId) }),
      }))
      .end(terminal<Record<never, never>, DownstreamHttpOutcome, GatewayPipelineServices>({
        name: 'response',
        tap: 'downstream',
        execute: async () => ({ status: 200, headers: [], body: new TextEncoder().encode('ok') }),
      }));

    await runPipeline(pipe, {
      'request.http': {
        method: 'POST',
        url: 'https://gateway.example/v1/test?token=secret',
        headers: [['authorization', secret('Bearer abcdef')]],
        body: { input: true },
      },
    }, { traceSink: sink, services: createGatewayPipelineServices(mockGatewayCtx()) });

    const decoder = createDumpDecoder();
    for (const chunk of chunks) decoder.pushNdjsonChunk(chunk);
    const model = decoder.pushNdjsonChunk(new Uint8Array(), { final: true });
    const wire = projectWireView(model);

    expect(wire.downstreamRequest?.method).toBe('POST');
    expect(wire.downstreamResponse?.status).toBe(200);
    expect(isEventStreamMediaType('text/event-stream')).toBe(true);
  });
});

test('relayedResponseHeaderEntries strips hop-by-hop, representation, and cookie headers while preserving content-type and trace headers', () => {
  const relayed = relayedResponseHeaderEntries([
    ['connection', 'close'],
    ['content-encoding', 'gzip'],
    ['content-length', '999'],
    ['content-type', 'application/json'],
    ['set-cookie', 'session=upstream-secret'],
    ['transfer-encoding', 'chunked'],
    ['x-oai-request-id', 'req_search_1'],
  ]);
  expect(relayed).toEqual([
    ['content-type', 'application/json'],
    ['x-oai-request-id', 'req_search_1'],
  ]);
});
