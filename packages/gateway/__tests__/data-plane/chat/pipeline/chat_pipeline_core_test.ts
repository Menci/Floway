import { afterEach, expect, test, vi } from 'vitest';

import {
  applyTranslationTripToOutcome,
  createChatPipelineServices,
  defineRouteAffinityRequest,
  plainOutcomeFromHttpOutcome,
  providerStreamOutcomeToChatOutcome,
  readUpstreamApiErrorFromHttpOutcome,
  selectRouteAffinityCandidates,
} from '../../../../src/data-plane/chat/pipeline/index.ts';
import type {
  ChatAttemptOutcome,
  ChatPipelineServices,
} from '../../../../src/data-plane/chat/pipeline/index.ts';
import type { DownstreamHttpOutcome } from '../../../../src/data-plane/pipeline/index.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import {
  createDumpDecoder,
  createDumpEncoder,
  freezeValue,
  pipeline,
  projectWireView,
  runPipeline,
  terminal,
} from '@floway-dev/pipeline';
import type {
  ManagedStream,
  RunTraceSink,
  StageEnv,
} from '@floway-dev/pipeline';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import {
  readManagedBytes,
  toProviderModelFacts,
} from '@floway-dev/provider';
import type {
  HttpOutcome,
  ProviderPipelineStreamOutcome,
  RouteCandidate,
} from '@floway-dev/provider';
import { stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { TranslateTrip } from '@floway-dev/translate';

interface TestEvent {
  readonly choices?: ReadonlyArray<{ readonly delta: { readonly content: string } }>;
  readonly usage?: BillableUsage;
}

const testServices = (): { readonly ctx: ReturnType<typeof mockChatGatewayCtx>; readonly services: ChatPipelineServices } => {
  const ctx = mockChatGatewayCtx({ apiKeyId: 'key_pipeline_core' });
  return { ctx, services: createChatPipelineServices(ctx) };
};

const runTerminal = async <Out>(
  name: string,
  execute: (env: StageEnv<ChatPipelineServices>) => Promise<Out>,
  services: ChatPipelineServices,
): Promise<Out> => {
  const pipe = pipeline<Record<never, never>>(name).end(terminal<Record<never, never>, Out, ChatPipelineServices>({
    name: `${name}.end`,
    execute: async (_facts, env) => await execute(env),
  }));
  return await runPipeline(pipe, {}, { services });
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('all chat attempt outcome variants cross the pipeline freeze boundary', async () => {
  const { services } = testServices();
  const outcomes: ChatAttemptOutcome<TestEvent>[] = [];

  for (const variant of ['events', 'api-error', 'internal-error', 'plain'] as const) {
    const outcome = await runTerminal<ChatAttemptOutcome<TestEvent>>(`freeze.${variant}`, async (env): Promise<ChatAttemptOutcome<TestEvent>> => {
      const headers = Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]);
      if (variant === 'events') {
        return {
          type: 'events',
          events: env.createStream<ProtocolFrame<TestEvent>>({
            label: 'protocol.events',
            async *iterate() {
              yield eventFrame({ choices: [{ delta: { content: 'hello' } }] });
              yield doneFrame();
            },
          }),
          modelIdentity: testTelemetryModelIdentity,
          http: { status: 200, statusText: 'OK', headers },
        };
      }
      if (variant === 'api-error') {
        return {
          type: 'api-error',
          source: 'upstream',
          upstreamId: testTelemetryModelIdentity.upstream,
          http: { status: 429, statusText: 'Too Many Requests', headers },
          body: new TextEncoder().encode('{"error":"limited"}'),
        };
      }
      if (variant === 'internal-error') {
        return {
          type: 'internal-error',
          http: { status: 502, headers },
          error: { type: 'internal_error', name: 'Error', message: 'parser failed' },
        };
      }
      return {
        type: 'plain',
        upstreamId: testTelemetryModelIdentity.upstream,
        http: { status: 200, headers },
        body: null,
      };
    }, services);
    outcomes.push(outcome);
    expect(Object.isFrozen(outcome)).toBe(true);
    if (outcome.type === 'events') {
      for await (const _frame of outcome.events) {
        // Draining releases the managed stream through the normal pipeline path.
      }
    }
  }

  expect(outcomes.map(outcome => outcome.type)).toEqual(['events', 'api-error', 'internal-error', 'plain']);
});

test('HTTP outcome conversion distinguishes null and empty bodies and supplies a default JSON content type', async () => {
  const { services } = testServices();
  const converted = await runTerminal('http.outcomes', async env => {
    const http = (body: HttpOutcome['body'], headers: HttpOutcome['headers'] = []): HttpOutcome => ({
      status: 502,
      statusText: 'Bad Gateway',
      headers,
      body,
      timing: { startedAtMs: 1, headersAtMs: 2 },
    });
    const emptyBody = (): HttpOutcome['body'] => env.createStream<Uint8Array>({
      label: 'http.body',
      async *iterate() {},
    });
    return {
      nullApiError: await readUpstreamApiErrorFromHttpOutcome(http(null), 'up_wire'),
      emptyApiError: await readUpstreamApiErrorFromHttpOutcome(http(emptyBody()), 'up_wire'),
      nullPlain: await plainOutcomeFromHttpOutcome(http(null)),
      typedPlain: await plainOutcomeFromHttpOutcome(http(emptyBody(), [['Content-Type', 'text/plain']])),
    };
  }, services);

  expect(converted.nullApiError.body).toBeNull();
  expect(converted.emptyApiError.body).toEqual(new Uint8Array());
  expect(converted.nullPlain.http.headers).toEqual([['content-type', 'application/json']]);
  expect(converted.typedPlain.http.headers).toEqual([['Content-Type', 'text/plain']]);
});

const meteredFrames = (usage: readonly BillableUsage[]): ProtocolFrame<TestEvent>[] => [
  eventFrame({
    choices: [{ delta: { content: 'hello' } }],
    usage: usage[0],
  }),
  eventFrame({
    choices: [{ delta: { content: ' world' } }],
    usage: usage[1],
  }),
  doneFrame(),
];

const runMeteredOutcome = async (
  usage: readonly BillableUsage[],
): Promise<{
  readonly ctx: ReturnType<typeof mockChatGatewayCtx>;
  readonly services: ChatPipelineServices;
  readonly outcome: Extract<ChatAttemptOutcome<TestEvent>, { type: 'events' }>;
}> => {
  const { ctx, services } = testServices();
  const outcome = await runTerminal('metered.events', async env => {
    const events = env.createStream<ProtocolFrame<TestEvent>>({
      label: 'provider.protocol.events',
      async *iterate() {
        for (const frame of meteredFrames(usage)) yield frame;
      },
    });
    const providerOutcome: ProviderPipelineStreamOutcome<TestEvent> = {
      ok: true,
      events,
      modelKey: testTelemetryModelIdentity.modelKey,
      http: {
        status: 200,
        statusText: 'OK',
        headers: Object.freeze([Object.freeze(['content-type', 'text/event-stream'] as const)]),
        timing: { startedAtMs: 1, headersAtMs: 2 },
      },
    };
    const converted = await providerStreamOutcomeToChatOutcome(
      providerOutcome,
      routeCandidate(testTelemetryModelIdentity.model),
      'openaiChatCompletions',
      env,
      event => event.usage ?? null,
    );
    if (converted.type !== 'events') throw new Error(`Expected events, received ${converted.type}`);
    return converted;
  }, services);
  return { ctx, services, outcome };
};

test('the usage ledger settles full stream consumption and preserves observed usage on cancellation', async () => {
  const firstUsage: BillableUsage = { input: 3, cacheRead: 1, cacheWrite: 0, cacheWrite1h: 0, output: 2 };
  const finalUsage: BillableUsage = { input: 7, cacheRead: 2, cacheWrite: 1, cacheWrite1h: 0, output: 9 };
  const now = vi.spyOn(performance, 'now').mockReturnValue(321);

  const complete = await runMeteredOutcome([firstUsage, finalUsage]);
  expect(complete.outcome.usageId).toBeDefined();
  const usageId = complete.outcome.usageId!;
  expect(complete.ctx.attempt.timing.firstOutputTokenAt).toBeNull();
  expect(complete.services.usageLedger.read(usageId, {
    modelIdentity: complete.outcome.modelIdentity,
    performance: complete.outcome.performance,
  }).billableUsage).toBeUndefined();
  for await (const _frame of complete.outcome.events) {
    // Full consumption is what lets the ledger observe the final usage frame.
  }
  expect(complete.ctx.attempt.timing.firstOutputTokenAt).toBe(321);
  expect(complete.services.usageLedger.read(usageId, {
    modelIdentity: complete.outcome.modelIdentity,
    performance: complete.outcome.performance,
  })).toMatchObject({ billableUsage: finalUsage });
  complete.services.usageLedger.setEntry(usageId, {
    modelIdentity: { ...complete.outcome.modelIdentity, modelKey: 'replacement-wire' },
  });
  expect(complete.services.usageLedger.read(usageId, {
    modelIdentity: complete.outcome.modelIdentity,
    performance: complete.outcome.performance,
  })).toEqual({
    modelIdentity: { ...complete.outcome.modelIdentity, modelKey: 'replacement-wire' },
  });

  now.mockReturnValue(654);
  const cancelled = await runMeteredOutcome([firstUsage, finalUsage]);
  const iterator = cancelled.outcome.events[Symbol.asyncIterator]();
  expect((await iterator.next()).done).toBe(false);
  await iterator.return?.();
  expect(cancelled.ctx.attempt.timing.firstOutputTokenAt).toBe(654);
  expect(cancelled.services.usageLedger.read(cancelled.outcome.usageId, {
    modelIdentity: cancelled.outcome.modelIdentity,
    performance: cancelled.outcome.performance,
  })).toMatchObject({ billableUsage: firstUsage });
});

const routeCandidate = (id: string): RouteCandidate => {
  const providerModel = Object.freeze(toProviderModelFacts(stubProviderModel({
    id,
    upstreamModelId: `wire-${id}`,
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
  })));
  return Object.freeze({
    upstreamId: 'up_affinity',
    upstreamName: 'Affinity Upstream',
    kind: 'custom',
    modelId: id,
    upstreamModelId: providerModel.upstreamModelId,
    endpoints: Object.freeze({ ...providerModel.endpoints }),
    limits: Object.freeze({ ...providerModel.limits }),
    providerModel,
  });
};

test('route affinity selection orders entries and materializes freezeable payloads after ordering', () => {
  const preferred = routeCandidate('preferred');
  const compatible = routeCandidate('compatible');
  const degrading = routeCandidate('degrading');
  const materialized: string[] = [];
  const affinity = defineRouteAffinityRequest<{ readonly nested: { readonly route: string } }>([], candidate => {
    const disposition = candidate.modelId === 'preferred'
      ? { degrades: false, preferred: true }
      : candidate.modelId === 'compatible'
        ? { degrades: false, preferred: false }
        : { degrades: true, preferred: false };
    return {
      kind: 'accepted',
      ...disposition,
      materialize: () => {
        materialized.push(candidate.modelId);
        return { nested: { route: candidate.modelId } };
      },
    };
  });

  const selection = selectRouteAffinityCandidates([degrading, compatible, preferred], affinity);
  if ('kind' in selection) throw new Error(selection.message);

  expect(materialized).toEqual(['preferred', 'compatible', 'degrading']);
  expect(selection.entries.map(entry => entry.payload.nested.route)).toEqual([
    'preferred',
    'compatible',
    'degrading',
  ]);
  expect(() => freezeValue(selection.entries)).not.toThrow();
  expect(Object.isFrozen(selection.entries)).toBe(true);
  expect(selection.entries.every(Object.isFrozen)).toBe(true);
  expect(selection.entries.every(entry => Object.isFrozen(entry.payload.nested))).toBe(true);

  const { ctx, services } = testServices();
  services.affinity.select(preferred);
  expect(services.affinity.selectedTarget()).toEqual(ctx.affinity.selectedTarget());
  expect(services.affinity.egressOptions().codec).toBe(ctx.affinity.codec);
});

const traceSink = (): { readonly sink: RunTraceSink; readonly read: () => ReturnType<ReturnType<typeof createDumpDecoder>['pushNdjsonChunk']> } => {
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      push: event => {
        for (const encoded of encoder.encodeBatch([event])) {
          chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`));
        }
      },
    },
    read: () => {
      const decoder = createDumpDecoder();
      const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return decoder.pushNdjsonChunk(bytes, { final: true });
    },
  };
};

interface TargetEvent { readonly type: 'target.delta'; readonly text: string }
interface SourceEvent { readonly type: 'source.delta'; readonly text: string }

const translationTrip = (): TranslateTrip<Record<never, never>, SourceEvent, TargetEvent> => ({
  type: 'trip',
  target: {},
  async *events(frames) {
    for await (const frame of frames) {
      if (frame.type === 'event') yield eventFrame({ type: 'source.delta', text: frame.event.text });
      else yield doneFrame();
    }
  },
  error: () => ({
    status: 422,
    headers: new Headers({ 'content-type': 'application/json', 'x-rewritten': 'yes' }),
    body: { error: { message: 'rewritten' } },
  }),
});

test('translation rewrites upstream api errors and preserves translated stream lineage through Dump V2', async () => {
  const rewriteServices = testServices();
  const rewritten = await runTerminal('translated.error', async env =>
    applyTranslationTripToOutcome(env, translationTrip(), 'anthropicMessages', {
      type: 'api-error',
      source: 'upstream',
      upstreamId: 'up_wire',
      http: {
        status: 503,
        headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
      },
      body: new TextEncoder().encode('{"error":{"message":"raw"}}'),
    }), rewriteServices.services);

  if (rewritten.type !== 'api-error') throw new Error(`Expected api-error, received ${rewritten.type}`);
  expect(rewriteServices.services.attribution.targetApi).toBe('anthropicMessages');
  expect(rewritten.http.status).toBe(422);
  expect(rewritten.http.headers).toContainEqual(['x-rewritten', 'yes']);
  expect(JSON.parse(new TextDecoder().decode(rewritten.body!))).toEqual({ error: { message: 'rewritten' } });

  const trace = traceSink();
  const streamServices = testServices();
  const pipe = pipeline<Record<never, never>>('translated.stream')
    .end(terminal<Record<never, never>, DownstreamHttpOutcome, ChatPipelineServices>({
      name: 'translated.stream.end',
      tap: 'downstream',
      execute: async (_facts, env) => {
        const targetEvents = env.createStream<ProtocolFrame<TargetEvent>>({
          label: 'protocol.events',
          async *iterate() {
            yield eventFrame({ type: 'target.delta', text: 'hello' });
            yield doneFrame();
          },
        });
        const translated = applyTranslationTripToOutcome(env, translationTrip(), 'anthropicMessages', {
          type: 'events',
          events: targetEvents,
          modelIdentity: testTelemetryModelIdentity,
          http: { status: 200, headers: Object.freeze([]) },
        });
        if (translated.type !== 'events') throw new Error(`Expected events, received ${translated.type}`);
        const encoder = new TextEncoder();
        const bytes = env.wrapStream<ProtocolFrame<SourceEvent>, Uint8Array>(translated.events, {
          label: 'downstream.sse.bytes',
          async *transform(source) {
            for await (const frame of source) {
              if (frame.type === 'event') yield encoder.encode(`data: ${JSON.stringify(frame.event)}\n\n`);
              else yield encoder.encode('data: [DONE]\n\n');
            }
          },
        });
        return {
          status: 200,
          headers: Object.freeze([Object.freeze(['content-type', 'text/event-stream'] as const)]),
          body: bytes,
          sse: { keepAliveIntervalMs: 60_000 },
        };
      },
    }));
  const downstream = await runPipeline(pipe, {}, { services: streamServices.services, traceSink: trace.sink });
  if (downstream.body === null || downstream.body instanceof Uint8Array) throw new Error('Expected a managed response stream');
  await readManagedBytes(downstream.body as ManagedStream<Uint8Array>);

  const model = trace.read();
  const wire = projectWireView(model);
  const response = wire.downstreamResponse;
  expect(response?.status).toBe(200);
  expect(response?.protocolStreamId).toBeDefined();
  expect(response?.protocolFrames.map(frame => (frame.value as ProtocolFrame<SourceEvent>).type)).toContain('event');
  if (response?.protocolStreamId === undefined) throw new Error('Expected a downstream protocol stream');
  const translatedStream = model.streams.get(response.protocolStreamId);
  expect(translatedStream?.label).toBe('translated.protocol.events');
  expect(translatedStream?.wraps).toBeDefined();
  const targetStream = model.streams.get(translatedStream!.wraps!);
  expect(targetStream?.label).toBe('protocol.events');
  expect(targetStream?.frames.map(frame => (frame.value as ProtocolFrame<TargetEvent>).type)).toContain('event');
});
