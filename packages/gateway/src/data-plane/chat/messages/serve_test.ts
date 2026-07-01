import { afterEach, test, vi } from 'vitest';

import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, defaultsForProvider, directFetcher, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

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

const { messagesServe } = await import('./serve.ts');

const API_KEY_ID = 'key_messages_serve_test';

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
  endpoints?: ModelEndpoints;
  kind?: ModelCandidate['provider']['kind'];
  enabledFlags?: ReadonlySet<string>;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callResponses?: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>;
  callMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const kind = overrides.kind ?? 'custom';
  const provider = stubProvider({
    callMessages: overrides.callMessages,
    callResponses: overrides.callResponses,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream, kind, name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, instance: provider, supportsResponsesItemReference: true,
    },
    model: stubInternalModel({
      ...(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
      providerModels: {
        [upstream]: stubProviderModel({
          ...(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
          ...(overrides.enabledFlags ? { enabledFlags: overrides.enabledFlags } : {}),
        }),
      },
    }, upstream),
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
    headers: new Headers(),
  });

  const events = await collectEvents(assertResultType(result, 'events').events);
  assert(events.length >= 1);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate translates through the Responses target when only that endpoint is exposed', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProtocolFrames([makeResponsesResultEvent()]),
    modelKey: 'responses-model-key',
    headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ upstream: 'up_r', endpoints: { responses: {} }, callResponses })]);

  const result = await messagesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  await collectEvents(assertResultType(result, 'events').events);
  assertEquals(callResponses.mock.calls.length, 1);
});

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
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
  const lastError = new Response('last', { status: 502 });
  queueCandidates([
    makeCandidate({ upstream: 'up_a', callMessages: async () => ({ ok: false, response: firstError, modelKey: 'first-key' }) }),
    makeCandidate({ upstream: 'up_b', callMessages: async () => ({ ok: false, response: lastError, modelKey: 'last-key' }) }),
  ]);

  const result = await messagesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  const failure = assertResultType(result, 'api-error');
  assertEquals(failure.status, 502);
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
    headers: new Headers(),
  });

  const failure = assertResultType(result, 'api-error');
  assertEquals(failure.status, 404);
  const body = JSON.parse(new TextDecoder().decode(failure.body));
  assertEquals(body.error.type, 'not_found_error');
  assertEquals(body.error.message, 'Model unknown-model is not available on any configured upstream.');
});

test('generate filters out candidates whose endpoints do not satisfy the messages-generate preference and renders model-unsupported as a 400', async () => {
  installRepo();
  const callMessages = vi.fn();
  // messagesGenerateTarget prefers messages > responses > chat-completions; an
  // endpoints-only `completions` candidate matches none and is filtered out.
  queueCandidates([makeCandidate({ upstream: 'up_x', endpoints: { completions: {} }, callMessages })]);

  const result = await messagesServe.generate({
    payload: makePayload({ model: 'wrong-endpoint-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  const failure = assertResultType(result, 'api-error');
  assertEquals(failure.status, 400);
  const body = JSON.parse(new TextDecoder().decode(failure.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callMessages.mock.calls.length, 0);
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
    headers: new Headers(),
  });

  const plain = assertResultType(result, 'plain');
  assertEquals(plain.status, 200);
  const body = JSON.parse(new TextDecoder().decode(plain.body));
  assertEquals(body.input_tokens, 42);
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
});

test('countTokens renders model-missing as a 404 when no candidates are available', async () => {
  installRepo();
  queueCandidates([]);

  const result = await messagesServe.countTokens({
    payload: makePayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  const failure = assertResultType(result, 'api-error');
  assertEquals(failure.status, 404);
  const body = JSON.parse(new TextDecoder().decode(failure.body));
  assertEquals(body.error.type, 'not_found_error');
  assertEquals(body.error.message, 'Model unknown-model is not available on any configured upstream.');
});

test('countTokens filters out candidates whose endpoints do not satisfy the messages-countTokens preference and renders model-unsupported as a 400', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn();
  // messagesCountTokensTarget = chatTargetPicker(['messages']); a candidate
  // exposing only chatCompletions matches none and is filtered out.
  queueCandidates([makeCandidate({ upstream: 'up_x', endpoints: { chatCompletions: {} }, callMessagesCountTokens })]);

  const result = await messagesServe.countTokens({
    payload: makePayload({ model: 'wrong-endpoint-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  const failure = assertResultType(result, 'api-error');
  assertEquals(failure.status, 400);
  const body = JSON.parse(new TextDecoder().decode(failure.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callMessagesCountTokens.mock.calls.length, 0);
});

// strip-billing-attribution defaults OFF for claude-code, so a request whose
// system prompt carries the `x-anthropic-billing-header:` block must reach
// the claude-code provider's callMessages with the block intact — otherwise
// Anthropic loses the plan-tier attribution it bills against.
test('claude-code candidate preserves x-anthropic-billing-header system block through the interceptor chain', async () => {
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
      kind: 'claude-code',
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

// The same request routed to a copilot candidate (which carries the
// strip-billing-attribution default-on flag) must have the billing block
// stripped before the upstream call — the mirror image of the claude-code
// assertion above.
test('copilot candidate strips x-anthropic-billing-header system block via the default-on flag', async () => {
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
      kind: 'copilot',
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
    headers: new Headers(),
  });

  await collectEvents(assertResultType(result, 'events').events);

  assertEquals(callMessages.mock.calls.length, 1);
  const observed = capturedBodies[0]!;
  assertIsArray<{ text: string }>(observed.system);
  assertEquals(observed.system.length, 1);
  assertEquals(observed.system[0].text, 'You are a helpful assistant.');
});
