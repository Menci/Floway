import { test, vi } from 'vitest';

import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { defaultsForProvider, directFetcher, type ProviderCallResult, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

const candidatesQueue: { readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean }[] = [];
vi.mock('../shared/candidates.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../shared/candidates.ts')>();
  return {
    ...original,
    enumerateProviderCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('serve_test: no candidates enqueued');
      return next;
    }),
  };
});

const { messagesServe } = await import('./serve.ts');

const API_KEY_ID = 'key_messages_serve_test';

const queueCandidates = (candidates: readonly ProviderCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeGatewayCtx = (): GatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
});

const makePayload = (overrides: Partial<MessagesPayload> = {}): MessagesPayload => ({
  model: 'test-model',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeMessagesResultEvents = (id = 'msg_test'): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hi' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 1 },
  },
  { type: 'message_stop' },
];

const makeResponsesResultEvent = (id = 'resp_test'): ResponsesStreamEvent => {
  const response: ResponsesResult = {
    id,
    object: 'response',
    model: 'test-model',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg_resp',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hi from responses' }],
    }],
    output_text: 'hi from responses',
    error: null,
    incomplete_details: null,
  };
  return { type: 'response.completed', sequence_number: 0, response };
};

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: ProviderCandidate['targetApi'];
  providerKind?: ProviderCandidate['provider']['providerKind'];
  enabledFlags?: ReadonlySet<string>;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callResponses?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ResponsesStreamEvent>>;
  callMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'messages';
  const providerKind = overrides.providerKind ?? 'custom';
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callMessages: overrides.callMessages,
    callResponses: overrides.callResponses,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream,
      providerKind,
      name: upstream,
      disabledPublicModelIds: [],
      provider,
      supportsResponsesItemReference: true,
    },
    binding: {
      upstream,
      upstreamName: upstream,
      providerKind,
      provider,
      upstreamModel,
      enabledFlags: overrides.enabledFlags ?? upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi,
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

// `assertEquals(result.type, X)` does not narrow the union in the TS type
// checker; the manual `if (result.type !== X) throw` follow-up was pure
// type-narrowing scaffold. This helper asserts the variant and returns the
// narrowed value so call sites stay on a single line.
const assertResultType = <U extends { type: string }, T extends U['type']>(
  result: U,
  type: T,
): Extract<U, { type: T }> => {
  assertEquals(result.type, type);
  return result as Extract<U, { type: T }>;
};

function assertIsArray<T>(value: unknown): asserts value is readonly T[] {
  assert(Array.isArray(value));
}

test('generate routes a native Messages candidate end to end', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames(makeMessagesResultEvents()),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ upstream: 'up_a', callMessages })]);

  const result = await messagesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  const events = await collectEvents(assertResultType(result, 'events').events);
  assert(events.length >= 1);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate translates through the Responses target when only that endpoint is exposed', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([makeResponsesResultEvent()]),
    modelKey: 'responses-model-key',
    headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ upstream: 'up_r', targetApi: 'responses', callResponses })]);

  const result = await messagesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  await collectEvents(assertResultType(result, 'events').events);
  assertEquals(callResponses.mock.calls.length, 1);
});

test('generate stops at the first candidate even when it yields an upstream error', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: false, response: firstError, modelKey: 'first-key',
  }));
  const secondCall = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesResultEvents('msg_second')), modelKey: 'second-key', headers: new Headers(),
  }));
  queueCandidates([
    makeCandidate({ upstream: 'up_a', callMessages: firstCall }),
    makeCandidate({ upstream: 'up_b', callMessages: secondCall }),
  ]);

  const result = await messagesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  // An upstream error from the first candidate IS the final answer — the
  // gateway does not retry on a different upstream just because the first one
  // produced an HTTP error.
  assertEquals(result.type, 'api-error');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 0);
});

test('generate stops at the first candidate when the payload has no reasoning carriers to route on', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames(makeMessagesResultEvents()),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueCandidates([
    makeCandidate({ upstream: 'up_a', callMessages }),
    makeCandidate({ upstream: 'up_b', callMessages }),
  ]);

  const result = await messagesServe.generate({
    payload: makePayload({ messages: [{ role: 'user', content: 'hi' }] }),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  await collectEvents(assertResultType(result, 'events').events);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate renders model-missing when no candidates are available', async () => {
  installRepo();
  queueCandidates([]);

  const result = await messagesServe.generate({
    payload: makePayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  const failure = assertResultType(result, 'api-error');
  assertEquals(failure.status, 404);
  const body = JSON.parse(new TextDecoder().decode(failure.body));
  assertEquals(body.error.type, 'not_found_error');
  assertEquals(body.error.message, 'Model unknown-model is not available on any configured upstream.');
});

test('countTokens proxies the upstream measurement response as a plain result', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 42 }), {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
    }),
    modelKey: 'test-model-key',
  }));
  queueCandidates([makeCandidate({ upstream: 'up_a', callMessagesCountTokens })]);

  const result = await messagesServe.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  const plain = assertResultType(result, 'plain');
  assertEquals(plain.status, 200);
  const body = JSON.parse(new TextDecoder().decode(plain.body));
  assertEquals(body.input_tokens, 42);
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
});

// strip-billing-attribution defaults OFF for claude-code, so a request whose
// system prompt carries the `x-anthropic-billing-header:` block must reach
// the claude-code provider's callMessages with the block intact — otherwise
// Anthropic loses the plan-tier attribution it bills against.
test('claude-code binding preserves x-anthropic-billing-header system block through the interceptor chain', async () => {
  installRepo();

  // Pre-confirm the flag catalog is wired the expected way; an edit that
  // adds 'claude-code' to defaultFor by mistake should fail at setup, not
  // silently pass on a stripped body.
  const claudeCodeDefaults = defaultsForProvider('claude-code');
  assertEquals(claudeCodeDefaults.has('strip-billing-attribution'), false);

  const billingBlock = 'x-anthropic-billing-header: per-turn-token\ncch=deadbeef1234;\ncc_entrypoint=cli';

  const capturedBodies: Omit<MessagesPayload, 'model'>[] = [];
  const callMessages = vi.fn(async (
    _model: unknown,
    body: unknown,
  ): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
    capturedBodies.push(body as Omit<MessagesPayload, 'model'>);
    return {
      ok: true,
      events: makeProtocolFrames(makeMessagesResultEvents()),
      modelKey: 'claude-sonnet-4-5-20250929',
    };
  });

  queueCandidates([
    makeCandidate({
      upstream: 'up_cc',
      providerKind: 'claude-code',
      enabledFlags: claudeCodeDefaults,
      callMessages,
    }),
  ]);

  const result = await messagesServe.generate({
    payload: makePayload({
      system: [
        { type: 'text', text: billingBlock },
        { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ],
    }),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  await collectEvents(assertResultType(result, 'events').events);

  assertEquals(callMessages.mock.calls.length, 1);
  const observed = capturedBodies[0]!;
  assertIsArray<{ text: string }>(observed.system);
  assertEquals(observed.system.length, 2);
  assertEquals(observed.system[0].text, billingBlock);
  assertEquals(observed.system[1].text, "You are Claude Code, Anthropic's official CLI for Claude.");
});

// The same request routed to a copilot binding (which carries the
// strip-billing-attribution default-on flag) must have the billing block
// stripped before the upstream call — the mirror image of the claude-code
// assertion above.
test('copilot binding strips x-anthropic-billing-header system block via the default-on flag', async () => {
  installRepo();

  const copilotDefaults = defaultsForProvider('copilot');
  assertEquals(copilotDefaults.has('strip-billing-attribution'), true);

  const billingBlock = 'x-anthropic-billing-header: per-turn-token\ncch=deadbeef1234;';

  const capturedBodies: Omit<MessagesPayload, 'model'>[] = [];
  const callMessages = vi.fn(async (
    _model: unknown,
    body: unknown,
  ): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
    capturedBodies.push(body as Omit<MessagesPayload, 'model'>);
    return {
      ok: true,
      events: makeProtocolFrames(makeMessagesResultEvents()),
      modelKey: 'claude-sonnet-4-5',
    };
  });

  queueCandidates([
    makeCandidate({
      upstream: 'up_co',
      providerKind: 'copilot',
      enabledFlags: copilotDefaults,
      callMessages,
    }),
  ]);

  const result = await messagesServe.generate({
    payload: makePayload({
      system: [
        { type: 'text', text: billingBlock },
        { type: 'text', text: 'You are a helpful assistant.' },
      ],
    }),
    ctx: makeGatewayCtx(),
    store: createNonResponsesSourceStore(API_KEY_ID),
    headers: new Headers(),
  });

  await collectEvents(assertResultType(result, 'events').events);

  assertEquals(callMessages.mock.calls.length, 1);
  const observed = capturedBodies[0]!;
  assertIsArray<{ text: string }>(observed.system);
  assertEquals(observed.system.length, 1);
  assertEquals(observed.system[0].text, 'You are a helpful assistant.');
});
