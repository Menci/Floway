import { afterEach, test, vi } from 'vitest';

import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ModelCandidate, directFetcher, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

// Mock the candidates seam so each test hands the serve exactly the
// provider candidates it wants.
const candidatesQueue: { readonly candidates: readonly ModelCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }[] = [];
vi.mock('../../providers/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../providers/registry.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('serve_test: no candidates enqueued');
      return next;
    }),
  };
});

const { chatCompletionsServe } = await import('./serve.ts');

const API_KEY_ID = 'key_chat_completions_serve_test';

const queueCandidates = (candidates: readonly ModelCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel, failedUpstreams: [] });
};

afterEach(() => { candidatesQueue.length = 0; });

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeGatewayCtx = (): ChatGatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore(API_KEY_ID),
});

const makePayload = (overrides: Partial<ChatCompletionsPayload> = {}): ChatCompletionsPayload => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeChatCompletionsEvents = (): readonly ChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callChatCompletions: overrides.callChatCompletions,
  });
  return {
    provider: {
      upstream, kind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, instance: provider, supportsResponsesItemReference: true,
    },
    model: stubInternalModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}, upstream),
    fetcher: directFetcher,
  };
};

const collectEvents = async <TEvent>(events: AsyncIterable<ProtocolFrame<TEvent>>): Promise<TEvent[]> => {
  const out: TEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('generate routes a native Chat Completions candidate end to end', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'test-model-key', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ upstream: 'up_a', callChatCompletions })]);

  const result = await chatCompletionsServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  const events = await collectEvents(result.events);
  assert(events.length >= 1);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('generate filters out candidates that do not expose any chat-completions-target endpoint', async () => {
  installRepo();
  const callChatCompletions = vi.fn();
  // `completions:{}` is not in the chatCompletionsTarget preference list
  // (`chat-completions` > `messages` > `responses`), so the picker rejects
  // this candidate.
  queueCandidates([makeCandidate({ upstream: 'up_m', endpoints: { completions: {} }, callChatCompletions })]);

  const result = await chatCompletionsServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  // canServe drops messages-only candidates; with no viable candidate the
  // serve renders model-unsupported as a 400 api-error (distinct from the
  // model-missing 404) without ever reaching the upstream call.
  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callChatCompletions.mock.calls.length, 0);
});

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: false, response: firstError, modelKey: 'first-key',
  }));
  const secondCall = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'second-key', headers: new Headers(),
  }));
  queueCandidates([
    makeCandidate({ upstream: 'up_a', callChatCompletions: firstCall }),
    makeCandidate({ upstream: 'up_b', callChatCompletions: secondCall }),
  ]);

  const result = await chatCompletionsServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  // The narrowed candidate list exists exactly so a transient upstream
  // failure (5xx/429/network) on one entry rolls over to the next. The
  // second candidate's success is the request's final answer.
  assertEquals(result.type, 'events');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 1);
});

test('generate surfaces the last upstream error verbatim when every candidate fails', async () => {
  installRepo();
  const firstError = new Response('first', { status: 503 });
  const lastError = new Response(JSON.stringify({ error: { message: 'last' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  queueCandidates([
    makeCandidate({ upstream: 'up_a', callChatCompletions: async () => ({ ok: false, response: firstError, modelKey: 'first-key' }) }),
    makeCandidate({ upstream: 'up_b', callChatCompletions: async () => ({ ok: false, response: lastError, modelKey: 'last-key' }) }),
  ]);

  const result = await chatCompletionsServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 502);
});

test('generate is a routing no-op when the payload carries no reasoning carriers (degenerate path)', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'test-model-key', headers: new Headers(),
  }));
  queueCandidates([
    makeCandidate({ upstream: 'up_a', callChatCompletions }),
    makeCandidate({ upstream: 'up_b', callChatCompletions }),
  ]);

  const result = await chatCompletionsServe.generate({
    // A bare user message: no reasoning blocks → affinity walk finds no
    // refs → both candidates surface in the original order.
    payload: makePayload({ messages: [{ role: 'user', content: 'hi' }] }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('generate renders model-missing when no candidates are available', async () => {
  installRepo();
  queueCandidates([]);

  const result = await chatCompletionsServe.generate({
    payload: makePayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.message, 'Model unknown-model is not available on any configured upstream.');
});
