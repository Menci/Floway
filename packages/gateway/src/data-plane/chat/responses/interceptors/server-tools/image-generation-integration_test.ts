import { beforeEach, test, vi } from 'vitest';

import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import type { ChatGatewayCtx } from '../../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../../items/store.ts';
import type { ResponsesInvocation } from '../types.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type EventResult, type ExecuteResult } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate } from '@floway-dev/test-utils';

// Dirty integration harness: mock the model registry so the image backend is a
// pair of in-test stubs, then drive the whole shim (function-tool rewrite,
// ReAct loop, dispatch, streaming relay, output feedback) over a scripted
// upstream. The stubs record every backend call so a test can assert what the
// shim actually forwarded — most importantly that an image generated in turn 1
// is re-collected as an edit source in turn 2.

interface BackendStub {
  generationsCalls: Record<string, unknown>[];
  editsForms: FormData[];
  nextGenerations: Response[];
  nextEdits: Response[];
  // When set, the next `enumerateModelCandidates` call returns this
  // shape verbatim instead of the default single in-test candidate; lets
  // a test drive `resolveImageCandidate`'s failure branches.
  nextResolutionOverride: { candidates: readonly unknown[]; sawModel: boolean; failedUpstreams: readonly string[] } | null;
}

// Hoisted so the vi.mock factory below can close over it; tests mutate the
// `next*` queues and read back the recorded calls.
const stub = vi.hoisted((): BackendStub => ({ generationsCalls: [], editsForms: [], nextGenerations: [], nextEdits: [], nextResolutionOverride: null }));

const defaultCandidates = vi.hoisted(() => () => [{
  provider: {
    upstream: 'u',
    kind: 'custom',
    name: 'mock-image',
    disabledPublicModelIds: [],
    modelPrefix: null,
    supportsResponsesItemReference: false,
    instance: {
      getPricingForModelKey: () => null,
      callImagesGenerations: async (_model: unknown, body: Record<string, unknown>, _signal: unknown, opts: { recordUpstreamLatency: <T>(p: Promise<T>) => Promise<T> }) => {
        stub.generationsCalls.push(body);
        const response = stub.nextGenerations.shift();
        if (response === undefined) throw new Error('test did not enqueue a generations response');
        return { response: await opts.recordUpstreamLatency(Promise.resolve(response)), modelKey: 'gpt-image-2' };
      },
      callImagesEdits: async (_model: unknown, form: FormData, _signal: unknown, opts: { recordUpstreamLatency: <T>(p: Promise<T>) => Promise<T> }) => {
        stub.editsForms.push(form);
        const response = stub.nextEdits.shift();
        if (response === undefined) throw new Error('test did not enqueue an edits response');
        return { response: await opts.recordUpstreamLatency(Promise.resolve(response)), modelKey: 'gpt-image-2' };
      },
    },
  },
  model: {
    id: 'gpt-image-2',
    endpoints: { imagesGenerations: {}, imagesEdits: {} },
    providerModels: {
      u: {
        id: 'gpt-image-2', limits: {}, kind: 'image',
        endpoints: { imagesGenerations: {}, imagesEdits: {} },
        enabledFlags: new Set<string>(),
      },
    },
  },
  fetcher: (request: Request) => fetch(request),
}]);

vi.mock('../../../../providers/registry.ts', () => ({
  enumerateModelCandidates: vi.fn(async () => {
    const override = stub.nextResolutionOverride;
    if (override !== null) {
      stub.nextResolutionOverride = null;
      return override;
    }
    return { candidates: defaultCandidates(), sawModel: true, failedUpstreams: [] };
  }),
}));

// Imported AFTER vi.mock so the mocked registry is in effect.
const { withResponsesServerToolShim } = await import('../server-tool-shim.ts');
const { imageGenerationServerTool } = await import('./image-generation.ts');

const shim = withResponsesServerToolShim([imageGenerationServerTool]);

const MODEL_IDENTITY = { model: 'orchestrator', upstream: 'u', modelKey: 'orchestrator', cost: null };

const emptyResult = (status: ResponsesResult['status']): ResponsesResult => ({
  id: 'upstream', object: 'response', model: 'orchestrator', output: [], output_text: '', status, error: null, incomplete_details: null,
});

const jsonResponse = (b64: string): Response =>
  new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });

const sseResponse = (lines: string[]): Response =>
  new Response(lines.map(l => `data: ${l}\n\n`).join(''), { status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }) });

const rateLimitResponse = (retryAfterMs: number | null): Response => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (retryAfterMs !== null) headers['retry-after-ms'] = String(retryAfterMs);
  return new Response(
    JSON.stringify({ error: { code: 'RateLimitReached', type: 'image_generation_error', message: 'rate limited' } }),
    { status: 429, headers },
  );
};

// One scripted upstream turn: the orchestrator calls image_generation with the
// given prompt, then the upstream completes.
const callTurn = (outputIndex: number, callId: string, prompt: string): ProtocolFrame<ResponsesStreamEvent>[] => {
  const args = JSON.stringify({ prompt });
  return [
    eventFrame({ type: 'response.created', response: emptyResult('in_progress') }),
    eventFrame({ type: 'response.output_item.added', output_index: outputIndex, item: { type: 'function_call', call_id: callId, name: 'image_generation', arguments: '', status: 'in_progress' } }),
    eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item: { type: 'function_call', call_id: callId, name: 'image_generation', arguments: args, status: 'completed' } }),
    eventFrame({ type: 'response.completed', response: emptyResult('completed') }),
  ] as ProtocolFrame<ResponsesStreamEvent>[];
};

const messageTurn = (text: string): ProtocolFrame<ResponsesStreamEvent>[] => [
  eventFrame({ type: 'response.created', response: emptyResult('in_progress') }),
  eventFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [], status: 'in_progress' } }),
  eventFrame({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] } }),
  eventFrame({ type: 'response.completed', response: emptyResult('completed') }),
] as ProtocolFrame<ResponsesStreamEvent>[];

const scriptedRun = (turns: ProtocolFrame<ResponsesStreamEvent>[][]) => {
  let i = 0;
  return async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    if (i >= turns.length) throw new Error(`unexpected run() call ${i + 1}; only ${turns.length} scripted`);
    const frames = turns[i++];
    const events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () { for (const f of frames) yield f; })();
    return { type: 'events', events, modelIdentity: MODEL_IDENTITY } as EventResult<ProtocolFrame<ResponsesStreamEvent>>;
  };
};

const makeCtx = (input: unknown[], action: 'generate' | 'edit' | 'auto' = 'auto', extraTool: Record<string, unknown> = {}): ResponsesInvocation => ({
  candidate: stubModelCandidate({
    enabledFlags: new Set(['responses-image-generation-shim']),
    model: { id: 'm', endpoints: { responses: {} } },
  }),
  targetApi: 'responses',
  payload: { model: 'orchestrator', input, tools: [{ type: 'image_generation', action, ...extraTool }] } as never,
  headers: new Headers(),
  action: 'generate',
});
const gatewayCtx = (): ChatGatewayCtx => ({
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
});

const drain = async (result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  if (result.type !== 'events') throw new Error(`expected events, got ${result.type}`);
  const out: ResponsesStreamEvent[] = [];
  for await (const f of result.events) if (f.type === 'event') out.push(f.event);
  return out;
};

beforeEach(async () => {
  const repo = new InMemoryRepo();
  // resolveImageCandidate still calls createPerRequestFetcher to satisfy the
  // production code path. Seed the in-memory repo with the mocked candidate's
  // upstream id so the fetcher mapper resolves it instead of throwing
  // "unknown upstream id: u".
  await repo.upstreams.save({
    id: 'u',
    kind: 'custom',
    name: 'mock-image',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    config: {
      baseUrl: 'https://unused.example.com',
      authStyle: 'bearer',
      apiKey: 'unused',
      endpoints: { imagesGenerations: {}, imagesEdits: {} },
      modelsFetch: { enabled: false, endpoint: '/models' },
      models: [],
    },
    state: null,
  });
  initRepo(repo);
  stub.generationsCalls = [];
  stub.editsForms = [];
  stub.nextGenerations = [];
  stub.nextEdits = [];
  stub.nextResolutionOverride = null;
});

test('generates an image end-to-end and emits the native lifecycle', async () => {
  stub.nextGenerations = [jsonResponse('R0VO')]; // "GEN"
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw a cat' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('here it is'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 1);
  assertEquals(stub.editsForms.length, 0);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; result: string; action: string } }).item;
  assertEquals(item.status, 'completed');
  assertEquals(item.result, 'R0VO');
  assertEquals(item.action, 'generate');
});

test('relays real partial_image frames when partial_images > 0', async () => {
  stub.nextGenerations = [sseResponse([
    JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'UDA=' }),
    JSON.stringify({ type: 'image_generation.partial_image', partial_image_index: 1, b64_json: 'UDE=' }),
    JSON.stringify({ type: 'image_generation.completed', b64_json: 'RklO' }),
  ])];
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw a cat' }], 'auto', { partial_images: 2 }), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('done'),
  ]));
  const events = await drain(result);

  const partials = events.filter(e => e.type === 'response.image_generation_call.partial_image');
  assertEquals(partials.length, 2);
  assertEquals((partials[0] as { partial_image_b64: string }).partial_image_b64, 'UDA=');
  assertEquals((partials[1] as { partial_image_index: number }).partial_image_index, 1);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assertEquals(((igcDone as { item: { result: string } }).item).result, 'RklO');
});

test('an image generated in turn 1 is re-collected as an edit source in turn 2', async () => {
  // Turn 1 generates "AAAA"; the shim feeds it back as an input_image. Turn 2's
  // call must therefore resolve to an EDIT whose image[] part carries those
  // exact bytes — proving the dispatcher re-collects the live input rather than
  // a frozen registration-time snapshot.
  stub.nextGenerations = [jsonResponse('QUFBQQ==')]; // "AAAA"
  stub.nextEdits = [jsonResponse('QkJCQg==')]; // "BBBB"
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw then border it' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    callTurn(0, 'call_2', 'add a black border'),
    messageTurn('done'),
  ]));
  await drain(result);

  assertEquals(stub.generationsCalls.length, 1);
  assertEquals(stub.editsForms.length, 1);
  const images = stub.editsForms[0].getAll('image[]');
  assertEquals(images.length, 1);
  const bytes = await (images[0] as Blob).text();
  assertEquals(bytes, 'AAAA');
});

test('retries on 429 and surfaces the eventual success', async () => {
  // Two 429s then success; the orchestrator should see one completed image_generation_call.
  stub.nextGenerations = [
    rateLimitResponse(1),
    rateLimitResponse(1),
    jsonResponse('T0s='),
  ];
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('done'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 3);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; result: string } }).item;
  assertEquals(item.status, 'completed');
  assertEquals(item.result, 'T0s=');
});

test('gives up after MAX_RATE_LIMIT_RETRIES on persistent 429 and surfaces a failed item', async () => {
  // 1 initial + MAX_RATE_LIMIT_RETRIES = 3 total 429s before giving up.
  stub.nextGenerations = [
    rateLimitResponse(1),
    rateLimitResponse(1),
    rateLimitResponse(1),
  ];
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('sorry'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 3);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; error: { code: string; type: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'RateLimitReached');
  assertEquals(item.error.type, 'image_generation_error');
});

test('does not retry non-rate-limit upstream failures', async () => {
  stub.nextGenerations = [
    new Response(
      JSON.stringify({ error: { code: 'invalid_value', type: 'invalid_request_error', message: 'bad size' } }),
      { status: 400, headers: new Headers({ 'content-type': 'application/json' }) },
    ),
  ];
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('sorry'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 1);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; error: { code: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'invalid_value');
});

// resolveImageCandidate failure branches: each variant is normalized into
// a terminal `image_generation_call` item with `status: 'failed'` and a
// specific error.code so the orchestrator can distinguish unknown-model
// from existing-but-unsupported.

test('resolveImageCandidate renders model_not_found when no upstream knows the model id', async () => {
  stub.nextResolutionOverride = { candidates: [], sawModel: false, failedUpstreams: [] };
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('sorry'),
  ]));
  const events = await drain(result);

  // Backend never reached: resolution fails before the upstream call.
  assertEquals(stub.generationsCalls.length, 0);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; error: { code: string; message: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'model_not_found');
  assert(item.error.message.includes("No upstream provides model 'gpt-image-2'"), `unexpected message: ${item.error.message}`);
});

test('resolveImageCandidate renders model_not_supported when sawModel=true but no candidate is an image kind', async () => {
  // Mirrors the resolver's "id exists in some catalog but the kind filter
  // dropped it" signal — sawModel=true, candidates=[].
  stub.nextResolutionOverride = { candidates: [], sawModel: true, failedUpstreams: [] };
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('sorry'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 0);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; error: { code: string; message: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'model_not_supported');
  assert(item.error.message.includes("Model 'gpt-image-2' is not an image model."), `unexpected message: ${item.error.message}`);
});

test('resolveImageCandidate renders model_not_supported when image-kind candidates exist but none expose the imagesGenerations endpoint', async () => {
  // The resolver produced an image-kind candidate but its `endpoints` does
  // not include the per-endpoint key the request needs (imagesGenerations).
  stub.nextResolutionOverride = {
    candidates: [stubModelCandidate({
      model: {
        id: 'gpt-image-2',
        kind: 'image',
        endpoints: { imagesEdits: {} },
      },
    })],
    sawModel: true,
    failedUpstreams: [],
  };
  const result = await shim(makeCtx([{ type: 'message', role: 'user', content: 'draw' }]), gatewayCtx(), scriptedRun([
    callTurn(0, 'call_1', 'a cat'),
    messageTurn('sorry'),
  ]));
  const events = await drain(result);

  assertEquals(stub.generationsCalls.length, 0);
  const igcDone = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'image_generation_call');
  assert(igcDone !== undefined);
  const item = (igcDone as { item: { status: string; error: { code: string; message: string } } }).item;
  assertEquals(item.status, 'failed');
  assertEquals(item.error.code, 'model_not_supported');
  assert(item.error.message.includes('/images/generations endpoint'), `unexpected message: ${item.error.message}`);
});
