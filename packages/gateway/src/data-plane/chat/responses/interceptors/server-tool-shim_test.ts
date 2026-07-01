import { beforeEach, test, vi } from 'vitest';

import { withResponsesServerToolShim } from './server-tool-shim.ts';
import {
  consumeTurnStreaming,
  createMergeState,
  materializeAccumulatedOutput,
  parseServerToolArguments,
  sumUsage,
  type InterceptedFunctionCall,
  type ServerToolResultSlot,
  type TurnSummary,
  type UpstreamTerminal,
} from './server-tool-shim.ts';
import { SHIM_TOOL_NAME, webSearchServerTool } from './server-tools/web-search.ts';
import type { ResponsesInterceptor, ResponsesInvocation } from './types.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { resolveConfiguredWebSearchProvider } from '../../../tools/web-search/provider.ts';
import type {
  ConfiguredWebSearchProvider,
  SearchConfig,
  WebSearchFetchPageRequest,
  WebSearchFetchPageResult,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '../../../tools/web-search/types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type {
  ResponsesOutputItem,
  ResponsesInputItem,
  ResponsesInputWebSearchCall,
  ResponsesOutputWebSearchCall,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStreamEvent,
  ResponsesTool,
  ResponsesToolChoice,
  ResponsesWebSearchAction,
} from '@floway-dev/protocols/responses';
import { type EventResult, type ExecuteResult } from '@floway-dev/provider';
import { assert, assertEquals, assertFalse, stubModelCandidate } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const withResponsesWebSearchShim = withResponsesServerToolShim([webSearchServerTool]);

const emptyResult = (id: string, status: ResponsesResult['status']): ResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  output: [],
  output_text: '',
  status,
  error: null,
  incomplete_details: null,
});

const mkResponseCreated = (responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.created',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkResponseInProgress = (responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.in_progress',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkFunctionCallAdded = (outputIndex: number, callId: string, name: string): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: '',
      status: 'in_progress',
    },
  });

const mkFunctionCallArgsDone = (outputIndex: number, args: string, itemId = `fc_${outputIndex}`): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  });

const mkFunctionCallDone = (outputIndex: number, callId: string, name: string, args: string): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'function_call',
      call_id: callId,
      name,
      arguments: args,
      status: 'completed',
    },
  });

const mkCustomToolCallAdded = (outputIndex: number, callId: string, name: string): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'custom_tool_call',
      call_id: callId,
      name,
      input: '',
    },
  });

const mkCustomToolCallInputDone = (outputIndex: number, input: string, itemId = `cti_${outputIndex}`): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.custom_tool_call_input.done',
    item_id: itemId,
    output_index: outputIndex,
    input,
  });

const mkCustomToolCallDone = (outputIndex: number, callId: string, name: string, input: string): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'custom_tool_call',
      call_id: callId,
      name,
      input,
    },
  });

const mkMessageAdded = (outputIndex: number): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    },
  });

const mkMessageDone = (outputIndex: number, text: string): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  });

const mkReasoningAdded = (outputIndex: number, reasoningId: string): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { type: 'reasoning', id: reasoningId, summary: [] },
  });

const mkReasoningDone = (outputIndex: number, reasoningId: string): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: { type: 'reasoning', id: reasoningId, summary: [] },
  });

// We replace `resolveConfiguredWebSearchProvider` because real provider
// construction (`createTavilyWebSearchProvider` etc.) would otherwise
// pull in network-hitting backend impls. Tests insert a SearchConfig
// row through the in-memory repo so `loadSearchConfig` returns
// non-default values; the mock then ignores the config and returns a
// test stub. Tests that need a specific configured state set
// `mockResolveConfigured.mockReturnValue(...)` per call.
vi.mock('../../../tools/web-search/provider.ts');

const mkResponseCompleted = (
  usage?: ResponsesResult['usage'],
  responseId = 'upstream_test',
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      ...emptyResult(responseId, 'completed'),
      ...(usage !== undefined ? { usage } : {}),
    },
  });

const mkResponseIncomplete = (
  incompleteDetails?: { reason: string },
  responseId = 'upstream_test',
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.incomplete',
    response: {
      ...emptyResult(responseId, 'incomplete'),
      ...(incompleteDetails !== undefined ? { incomplete_details: incompleteDetails } : {}),
    },
  });

// Integration tests for the Responses web_search shim. Internal helpers
// are unit-tested through focused web-search server-tool suites; this file covers
// activation gating, tool rewrite, multi-turn loop, downstream stream
// merge invariants, and error propagation.

// ── Test scaffolding ──────────────────────────────────────────────────────

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

interface ProviderOverrides {
  search?: (req: WebSearchProviderRequest) => Promise<WebSearchProviderResult> | WebSearchProviderResult;
  fetchPage?: (req: WebSearchFetchPageRequest) => Promise<WebSearchFetchPageResult> | WebSearchFetchPageResult;
}

interface BackendCall {
  kind: 'search' | 'fetchPage';
  request: WebSearchProviderRequest | WebSearchFetchPageRequest;
}

const makeStubProvider = (overrides: ProviderOverrides = {}): { provider: WebSearchProvider; calls: BackendCall[] } => {
  const calls: BackendCall[] = [];
  const provider: WebSearchProvider = {
    async search(request) {
      calls.push({ kind: 'search', request });
      if (overrides.search) return await overrides.search(request);
      return {
        type: 'ok',
        results: [
          {
            source: 'https://example.com/a',
            title: 'Example A',
            content: [{ type: 'text', text: 'snippet A' }],
          },
        ],
      };
    },
    async fetchPage(request) {
      calls.push({ kind: 'fetchPage', request });
      if (overrides.fetchPage) return await overrides.fetchPage(request);
      return {
        type: 'ok',
        pages: request.urls.map(url => ({
          url,
          title: 'Page',
          content: `body of ${url}`,
          truncated: false,
          fullContentBytes: 12,
        })),
        failures: [],
      };
    },
  };
  return { provider, calls };
};

interface DepsOverrides {
  configured?: ConfiguredWebSearchProvider;
  providerOverrides?: ProviderOverrides;
}

const mockResolveConfigured = vi.mocked(resolveConfiguredWebSearchProvider);

// Seed a per-test InMemoryRepo and a default tavily search config so
// `loadSearchConfig()` returns a non-default value. The actual provider
// construction is short-circuited by the module mock above; tests
// override `mockResolveConfigured` to point at a stub backend.
beforeEach(() => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.searchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'test-key' },
    microsoftGrounding: { apiKey: '' },
    jina: { apiKey: '' },
  } satisfies SearchConfig);
});

const makeStubDeps = (overrides: DepsOverrides = {}): {
  backend: { provider: WebSearchProvider; calls: BackendCall[] };
} => {
  const backend = makeStubProvider(overrides.providerOverrides);
  const configured: ConfiguredWebSearchProvider = overrides.configured ?? {
    type: 'enabled',
    provider: 'tavily',
    impl: backend.provider,
  };
  mockResolveConfigured.mockReturnValue(configured);
  return { backend };
};

interface InvocationOverrides {
  targetApi?: 'responses' | 'messages' | 'chat-completions';
  enabledFlags?: ReadonlySet<string>;
  payload?: Partial<ResponsesPayload>;
}

const makeInvocation = (overrides: InvocationOverrides = {}): ResponsesInvocation => ({
  candidate: stubModelCandidate({
    ...(overrides.enabledFlags ? { enabledFlags: overrides.enabledFlags } : {}),
    model: { id: 'claude-x', endpoints: { chatCompletions: {}, responses: {}, messages: {} } },
  }),
  // Default chat-completions so existing tests exercise the
  // function_call_output path. Tests that care about a specific target
  // set targetApi explicitly.
  targetApi: overrides.targetApi ?? 'chat-completions',
  payload: {
    model: 'claude-x',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: [{ type: 'web_search' }],
    // Opt the wire item into `results` so most tests can inspect them
    // directly; the new include-gating tests explicitly omit this and
    // assert the wire-item shape without `results`.
    include: ['web_search_call.results'],
    ...overrides.payload,
  } as CanonicalResponsesPayload,
  headers: new Headers(),
  action: 'generate',
});

const makeGatewayCtx = (apiKeyId: string = 'k1'): ChatGatewayCtx => ({
  apiKeyId,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore(apiKeyId),
});

const collectFrames = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const f of iter) out.push(f);
  return out;
};

// The shim streams lazily: backend calls, ctx.payload.input mutation, and
// subsequent run() calls all happen inside the events generator. Tests
// asserting on side-effects MUST drain the events stream first.
const runShimAndDrain = async (
  shim: ResponsesInterceptor,
  inv: ResponsesInvocation,
  gatewayCtx: ChatGatewayCtx,
  run: () => Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>,
): Promise<{
  result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>;
  frames: ProtocolFrame<ResponsesStreamEvent>[];
}> => {
  const result = await shim(inv, gatewayCtx, run);
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = result.type === 'events'
    ? await collectFrames(result.events)
    : [];
  return { result, frames };
};

// Drive run() N times with one scripted event array per call. Reaches past
// the scripted length crashes the test — invariant violations stay loud.
type ScriptedTurn = ProtocolFrame<ResponsesStreamEvent>[];

interface ScriptedRun {
  run: () => Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>;
  callCount: () => number;
}

const scriptedRun = (turns: ScriptedTurn[]): ScriptedRun => {
  let i = 0;
  return {
    run: async () => {
      if (i >= turns.length) throw new Error(`unexpected run() call ${i + 1}; only ${turns.length} turn(s) scripted`);
      const frames = turns[i++];
      const iterable: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of frames) yield f;
      })();
      const result: EventResult<ProtocolFrame<ResponsesStreamEvent>> = {
        type: 'events',
        events: iterable,
        modelIdentity: testTelemetryModelIdentity,
      };
      return result;
    },
    callCount: () => i,
  };
};

// `outputIndex` is the UPSTREAM index (which resets to 0 every run());
// the shim assigns its own downstream index.
const messageTurn = (text: string, outputIndex = 0): ScriptedTurn => [
  mkResponseCreated(),
  mkResponseInProgress(),
  mkMessageAdded(outputIndex),
  mkMessageDone(outputIndex, text),
  mkResponseCompleted(),
];

const fcTurn = (
  outputIndex: number,
  callId: string,
  name: string,
  argsJson: string,
): ScriptedTurn => [
  mkResponseCreated(),
  mkResponseInProgress(),
  mkFunctionCallAdded(outputIndex, callId, name),
  mkFunctionCallArgsDone(outputIndex, argsJson),
  mkFunctionCallDone(outputIndex, callId, name, argsJson),
  mkResponseCompleted(),
];

const searchCallTurn = (outputIndex: number, callId: string, query: string): ScriptedTurn =>
  fcTurn(outputIndex, callId, SHIM_TOOL_NAME, JSON.stringify({ search_query: [{ q: query }] }));

const openCallTurn = (outputIndex: number, callId: string, url: string): ScriptedTurn =>
  fcTurn(outputIndex, callId, SHIM_TOOL_NAME, JSON.stringify({ open: [{ ref_id: url }] }));

const findCallTurn = (outputIndex: number, callId: string, url: string, pattern: string): ScriptedTurn =>
  fcTurn(outputIndex, callId, SHIM_TOOL_NAME, JSON.stringify({ find: [{ ref_id: url, pattern }] }));

const eventPayloads = (frames: ProtocolFrame<ResponsesStreamEvent>[]): ResponsesStreamEvent[] =>
  frames.filter(f => f.type === 'event').map(f => (f as { type: 'event'; event: ResponsesStreamEvent }).event);

const outputItemDoneEvents = (frames: ProtocolFrame<ResponsesStreamEvent>[]): Array<Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>> =>
  eventPayloads(frames)
    .filter((e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> => e.type === 'response.output_item.done');

// ── Activation gating ──────────────────────────────────────────────────

test('shim no-ops when targetApi=responses and flag is off', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    targetApi: 'responses',
    enabledFlags: new Set<string>(),
  });
  const originalPayload = inv.payload;
  const script = scriptedRun([messageTurn('hi back')]);

  const result = await shim(inv, makeGatewayCtx(), script.run);

  assertEquals(script.callCount(), 1);
  // Payload reference unchanged: the shim did not rewrite tools.
  assertEquals(inv.payload, originalPayload);
  assertEquals(backend.calls.length, 0);
  assertEquals(result.type, 'events');
});

test('shim activates when targetApi=responses and flag is on', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    targetApi: 'responses',
    enabledFlags: new Set<string>(['responses-web-search-shim']),
  });
  const script = scriptedRun([messageTurn('done')]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(inv.payload.tools?.length, 1);
  assertEquals(inv.payload.tools?.[0].type, 'function');
  assertEquals((inv.payload.tools?.[0] as { name: string }).name, SHIM_TOOL_NAME);
});

test('shim activates when targetApi=messages and flag is off', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ targetApi: 'messages', enabledFlags: new Set<string>() });
  const script = scriptedRun([messageTurn('done')]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(inv.payload.tools?.length, 1);
});

test('shim activates when targetApi=chat-completions and flag is off', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ targetApi: 'chat-completions', enabledFlags: new Set<string>() });
  const script = scriptedRun([messageTurn('done')]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(inv.payload.tools?.length, 1);
});

test('shim no-ops when no hosted web_search tool is present', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [{ type: 'function', name: 'other', parameters: { type: 'object' }, strict: false }],
    },
  });
  const script = scriptedRun([messageTurn('done')]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(script.callCount(), 1);
  assertEquals(backend.calls.length, 0);
  assertEquals(inv.payload.tools?.length, 1);
  assertEquals(inv.payload.tools?.[0].type, 'function');
});

// ── Tool rewrite × 4 hosted alias types ────────────────────────────────

const hostedAliasTypes = ['web_search', 'web_search_2025_08_26', 'web_search_preview', 'web_search_preview_2025_03_11'] as const;
for (const type of hostedAliasTypes) {
  test(`shim rewrites hosted ${type} alias into the shim function tool`, async () => {
    makeStubDeps();
    const shim = withResponsesWebSearchShim;
    const inv = makeInvocation({
      payload: { tools: [{ type }] },
    });
    const script = scriptedRun([messageTurn('done')]);

    await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

    assertEquals(inv.payload.tools?.length, 1);
    assertEquals((inv.payload.tools?.[0] as { name?: string }).name, SHIM_TOOL_NAME);
  });
}

// ── tool_choice rewrite × 4 hosted-type values ─────────────────────────

for (const type of hostedAliasTypes) {
  test(`shim rewrites tool_choice {type: ${type}} to forced shim's function tool`, async () => {
    makeStubDeps();
    const shim = withResponsesWebSearchShim;
    const inv = makeInvocation({
      payload: {
        tools: [{ type }],
        tool_choice: { type },
      },
    });
    const script = scriptedRun([messageTurn('done')]);

    await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

    assertEquals(inv.payload.tool_choice, { type: 'function', name: SHIM_TOOL_NAME });
  });
}

// ── Per-tool fields propagate ──────────────────────────────────────────

test('shim propagates filters / user_location / search_context_size to backend', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: ['allowed.com'], blocked_domains: ['blocked.com'] },
          user_location: { city: 'Tokyo', country: 'JP' },
          search_context_size: 'high',
        },
      ],
    },
  });
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('summary', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(backend.calls.length, 1);
  const searchCall = backend.calls[0].request as WebSearchProviderRequest;
  assertEquals(searchCall.query, 'q1');
  assertEquals(searchCall.maxResults, 40);
  assertEquals(searchCall.allowedDomains, ['allowed.com']);
  assertEquals(searchCall.blockedDomains, ['blocked.com']);
  assertEquals(searchCall.userLocation, { city: 'Tokyo', country: 'JP' });
});

// ── Single-iteration message (no function calls) ───────────────────────

test('shim forwards a single-turn message without backend calls', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([messageTurn('hello back')]);

  const result = await shim(inv, makeGatewayCtx(), script.run);

  assertEquals(script.callCount(), 1);
  assertEquals(backend.calls.length, 0);
  assert(result.type === 'events');
  const frames = await collectFrames(result.events);
  const events = eventPayloads(frames);
  const types = events.map(e => e.type);
  assertEquals(types[0], 'response.created');
  assertEquals(types[1], 'response.in_progress');
  assertEquals(types[types.length - 1], 'response.completed');
});

// ── One search then message ────────────────────────────────────────────

test('shim drives one search then a final message in two upstream turns', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('summary', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const frames = await collectFrames(result.events);

  assertEquals(script.callCount(), 2);
  assertEquals(backend.calls.length, 1);
  assertEquals(backend.calls[0].kind, 'search');
  const input = inv.payload.input as ResponsesInputItem[];
  const tail = input.slice(-2);
  assertEquals(tail[0].type, 'function_call');
  assertEquals(tail[1].type, 'function_call_output');
  assert(tail[0].type === 'function_call');
  // Shim replay preserves the upstream's original shim call
  // verbatim (call_id, name, jsonrepair-canonical args) so the upstream
  // model on turn 2 sees its prior assistant turn unchanged.
  assertEquals(tail[0].call_id, 'call_1');
  const events = eventPayloads(frames);
  const wsCallTypes = events.filter(e => e.type.startsWith('response.web_search_call'));
  assertEquals(wsCallTypes.length, 3);
  assertEquals(events[events.length - 1].type, 'response.completed');
});

test('synthesized web_search_call ids are registered as gateway-synthetic on the request', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const ctx = makeGatewayCtx();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('summary', 0),
  ]);

  const { frames } = await runShimAndDrain(shim, inv, ctx, script.run);

  // Every web_search_call the shim synthesizes carries a gateway-minted id no
  // upstream issued; persistence relies on these being registered so it stores
  // them with no upstream identity (non_affinity).
  const doneEvents = outputItemDoneEvents(frames);
  const wsCallDoneIds = doneEvents.filter(e => e.item.type === 'web_search_call').map(e => e.item.id!);
  const store = ctx.store;
  assert(wsCallDoneIds.length > 0, 'expected a synthesized web_search_call');
  for (const id of wsCallDoneIds) {
    assert(id.startsWith('ws_gw_'));
    assert(store.isSyntheticItem(id), `expected ${id} registered as synthetic`);
  }
  // A genuine upstream item (the final message) is not registered.
  for (const e of doneEvents.filter(e => e.item.type === 'message')) {
    assertFalse(store.isSyntheticItem(e.item.id!));
  }
});

// ── find_in_page cache hit ────────────────────────────────────────────

test('find_in_page reuses cache when same URL was opened first', async () => {
  const { backend } = makeStubDeps({
    providerOverrides: {
      async fetchPage(req) {
        return {
          type: 'ok',
          pages: req.urls.map(url => ({
            url,
            title: 'p',
            content: 'hello world snippet',
            truncated: false,
            fullContentBytes: 19,
          })),
          failures: [],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    openCallTurn(0, 'call_o', 'https://example.com/p'),
    findCallTurn(0, 'call_f', 'https://example.com/p', 'world'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  // open issues fetchPage; find reuses cache → still 1 fetchPage call.
  const fetchCalls = backend.calls.filter(c => c.kind === 'fetchPage');
  assertEquals(fetchCalls.length, 1);
});

// ── find_in_page cache miss with implicit fetch ────────────────────────

test('find_in_page triggers implicit fetchPage when URL not cached', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    findCallTurn(0, 'call_f', 'https://example.com/fresh', 'body'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const fetchCalls = backend.calls.filter(c => c.kind === 'fetchPage');
  assertEquals(fetchCalls.length, 1);
});

// ── Iteration cap exhausted ───────────────────────────────────────────

test('iteration cap returns the iteration-cap notice without backend call on cap+1', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const searchTurns: ScriptedTurn[] = [];
  for (let i = 0; i < 30; i++) {
    searchTurns.push(searchCallTurn(0, `call_${i}`, `q${i}`));
  }
  searchTurns.push(searchCallTurn(0, 'call_cap', 'qcap'));
  searchTurns.push(messageTurn('done', 0));
  const script = scriptedRun(searchTurns);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  // 30 backend search calls, NOT 31 — the 31st short-circuits via the cap.
  const searchCalls = backend.calls.filter(c => c.kind === 'search');
  assertEquals(searchCalls.length, 30);
  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  assert((lastOutput as { output: string }).output.includes('iteration limit (30)'));

  // The cap-exceeded turn still synthesizes a full web_search_call
  // lifecycle: 31 done events = 30 successful + 1 capped. The capped
  // call surfaces as the schema-error shape (action.type='search' with
  // the cap diagnostic in queries[0]) rather than the original query —
  // the shim call is rejected before backend dispatch.
  const wsCallDone = events.filter((e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'web_search_call');
  assertEquals(wsCallDone.length, 31);
  const capItem = wsCallDone[30].item as ResponsesOutputWebSearchCall;
  assert(capItem.action !== undefined);
  assertEquals(capItem.action.type, 'search');
});

// ── Ambiguous multi-op function_call rejection ─────────────────────────────

// `web_search_call.action` carries exactly one action type; a shim call
// that mixes kinds (search + open) or stacks multiple non-search ops
// (multi `open`/`find`) cannot reduce to a single wsc and is rejected
// before backend dispatch. Multi-`search_query` collapses into one wsc
// with a multi-query search action — see the collapse tests below.

const assertAmbiguousShimRejection = async (args: string, backend: { calls: unknown[] }): Promise<void> => {
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const turn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_ambig', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, args),
    mkFunctionCallDone(0, 'call_ambig', SHIM_TOOL_NAME, args),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([turn, messageTurn('done', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  assertEquals(backend.calls.length, 0);
  const wsCallDone = events.filter((e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'web_search_call');
  assertEquals(wsCallDone.length, 1);
  const item = wsCallDone[0].item as ResponsesOutputWebSearchCall;
  assertEquals(item.action?.type, 'search');
  assert(Array.isArray(item.results));
  assert(item.results![0].snippet.includes('ambiguous'));
  assert(item.results![0].snippet.includes('one web_search_call'));
};

test('multi-kind shim call (search_query + open) is rejected as ambiguous before any backend dispatch', async () => {
  const { backend } = makeStubDeps();
  await assertAmbiguousShimRejection(
    JSON.stringify({ search_query: [{ q: 'q' }], open: [{ ref_id: 'https://example.com/' }] }),
    backend,
  );
});

test('multi-instance same-kind shim call (two open entries) is rejected as ambiguous', async () => {
  const { backend } = makeStubDeps();
  await assertAmbiguousShimRejection(
    JSON.stringify({ open: [{ ref_id: 'https://example.com/a' }, { ref_id: 'https://example.com/b' }] }),
    backend,
  );
});

test('multi-instance same-kind shim call (two find entries) is rejected as ambiguous', async () => {
  const { backend } = makeStubDeps();
  await assertAmbiguousShimRejection(
    JSON.stringify({ find: [{ ref_id: 'https://example.com/', pattern: 'a' }, { ref_id: 'https://example.com/', pattern: 'b' }] }),
    backend,
  );
});

// ── Multi-`search_query` collapse ─────────────────────────────────────
//
// `search_query: [...]` natively maps to `web_search_call.action.queries`
// (a string[]), so multi-entry batches stay 1:1 with one wsc carrying
// every query and the merged result set.

test('multi-`search_query` entries collapse into one web_search_call with a multi-query action and merged results', async () => {
  const calls: string[] = [];
  const { backend } = makeStubDeps({
    providerOverrides: {
      async search({ query }) {
        calls.push(query);
        return { type: 'ok', results: [{ source: `https://r/${query}`, title: query, content: [{ type: 'text', text: `result for ${query}` }] }] };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const args = JSON.stringify({ search_query: [{ q: 'q1' }, { q: 'q2' }, { q: 'q3' }] });
  const turn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_multi', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, args),
    mkFunctionCallDone(0, 'call_multi', SHIM_TOOL_NAME, args),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([turn, messageTurn('done', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  // Exactly one wsc on the wire.
  const wsCallDone = events.filter((e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'web_search_call');
  assertEquals(wsCallDone.length, 1);
  const item = wsCallDone[0].item as ResponsesOutputWebSearchCall;
  assertEquals(item.action?.type, 'search');
  const action = item.action as Extract<ResponsesWebSearchAction, { type: 'search' }>;
  assertEquals(action.queries, ['q1', 'q2', 'q3']);

  // Three backend search calls (one per query, parallel).
  const searchCalls = backend.calls.filter(c => c.kind === 'search');
  assertEquals(searchCalls.length, 3);
  assertEquals(calls.sort(), ['q1', 'q2', 'q3']);

  // Merged results in entry order.
  assertEquals(item.results?.map(r => r.url), ['https://r/q1', 'https://r/q2', 'https://r/q3']);
});

test('multi-`search_query` with one malformed entry (missing q) is rejected as ambiguous', async () => {
  const { backend } = makeStubDeps();
  await assertAmbiguousShimRejection(
    JSON.stringify({ search_query: [{ q: 'q1' }, {}] }),
    backend,
  );
});

// ── Backend search zero-results case ─────────────────────────────────

test('search returning zero results surfaces the "(no results)" template', async () => {
  makeStubDeps({
    providerOverrides: {
      async search() {
        return { type: 'ok', results: [] };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'empty-query'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  assertEquals(
    (lastOutput as { output: string }).output,
    'Search results for "empty-query":\n\n(no results)',
  );
});

// ── Backend search failure ────────────────────────────────────────────

test('backend search failure surfaces "Search failed: <message>"', async () => {
  makeStubDeps({
    providerOverrides: {
      async search() {
        return { type: 'error', errorCode: 'unavailable', message: 'upstream down' };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  const text = (lastOutput as { output: string }).output;
  assert(text.includes('Search failed:'));
  assert(text.includes('upstream down'));
});

// ── Backend fetchPage whole-batch failure ─────────────────────────────

test('fetchPage whole-batch failure surfaces the open-page error text', async () => {
  makeStubDeps({
    providerOverrides: {
      async fetchPage() {
        return { type: 'error', errorCode: 'unavailable', message: 'fetch broken' };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    openCallTurn(0, 'call_o', 'https://example.com/x'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  const text = (lastOutput as { output: string }).output;
  assert(text.includes('Error fetching URL `https://example.com/x`'));
  assert(text.includes('fetch broken'));
});

// ── Domain filter input validation ────────────────────────────────────

test('non-empty allowed_domains with every entry malformed is rejected as 400 invalid_request_error (no silent expansion to allow-all)', async () => {
  // Silently dropping every malformed entry would turn "only allow
  // this one site" into "allow every site" — strictly worse than a
  // loud 400 because the client believed they had a restrictive
  // allow-list.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: ['bad domain with space', 'no_underscore_either'] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assertEquals(result.type, 'api-error');
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  // Upstream is never invoked when the gate rejects.
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { message: string; type: string; param: string; code: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.code, 'invalid_request_error');
  assertEquals(body.error.param, 'tools');
  assert(body.error.message.includes('Invalid domain'));
});

test('non-empty blocked_domains with every entry malformed is rejected as 400 invalid_request_error (no silent expansion to block-nothing)', async () => {
  // Same logic mirrored on the block-list side: silently dropping
  // every malformed entry would turn "block these sites" into "block
  // nothing", letting traffic the client intended to block through.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: { blocked_domains: ['has spaces', '*.wildcards.not.supported'] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assertEquals(result.type, 'api-error');
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { message: string; type: string; param: string; code: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'tools');
});

test('domain lists with any malformed entry alongside valid entries are rejected per-entry (no silent drop)', async () => {
  // Per-entry strict validation: a single bad entry rejects the whole
  // list because silently dropping it would let traffic the client
  // believed was blocked / outside the allow-list through. The
  // diagnostic must name the offending index so the client can fix it.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: {
            allowed_domains: ['valid.com', 'bad domain'],
            blocked_domains: ['also.valid.com'],
          },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { type: string; param: string; message: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'tools');
  assert(body.error.message.includes('bad domain'));
});

test('multiple hosted web_search entries: filter CONTENT is validated on each (not just last-wins)', async () => {
  // `rewriteToolsForShim` last-wins on filter extraction, so a content
  // check against `rewritten.filters` alone would miss malformed
  // entries on earlier hosted tools that get discarded. Per-entry
  // validation catches them — first failure wins.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        // First entry has all-malformed allowed_domains. A last-wins
        // content check on rewritten.filters (= the second entry's
        // empty filters) would let this slip through.
        { type: 'web_search', filters: { allowed_domains: ['bad domain'] } },
        { type: 'web_search' },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string; type: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'tools');
});

test('omitted filters do not trigger the validation reject (no false positive on the default case)', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [{ type: 'web_search' }],
    },
  });
  const script = scriptedRun([messageTurn('done', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  await collectFrames(result.events);
});

test('allowed_domains containing a non-string entry rejects with 400 (no 502 crash from .trim())', async () => {
  // `normalizeDomainList` calls `.trim()` on every entry — a non-string
  // entry (number, object, null) crashes with a TypeError that surfaces
  // as a 502 internal-error envelope. Rejecting at the boundary with a
  // 400 invalid_request_error keeps clients on the diagnostic-rich error
  // shape SDKs already speak.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          // Cast through unknown — the protocol type declares
          // `string[]`, but runtime values can be anything.
          filters: { allowed_domains: [5] as unknown as string[] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { type: string; param: string; code: string; message: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'tools');
});

test('blocked_domains containing an object entry rejects with 400', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: { blocked_domains: [{}] as unknown as string[] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { type: string; param: string } };
  assertEquals(body.error.param, 'tools');
});

// ── Per-entry domain shape validation ────────────────────────────────
//
// Each entry must be a bare hostname per OpenAI's web_search docs
// (https://developers.openai.com/api/docs/guides/tools-web-search.md):
// "omit the HTTP or HTTPS prefix" and use a domain like `openai.com`.
// The shim rejects every deviation at the boundary so silent surface
// expansion is impossible — `blocked_domains: ['reddit.com',
// 'https://quora.com/']` used to silently leave quora unblocked
// because the second entry dropped during normalization.

const runShimWithDomainEntry = async (
  field: 'allowed_domains' | 'blocked_domains',
  raw: unknown,
) => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: { [field]: [raw] as unknown as string[] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  return { result, backend, script };
};

for (const field of ['allowed_domains', 'blocked_domains'] as const) {
  test(`${field} entry with https:// prefix rejects with 400 invalid domain`, async () => {
    const { result, backend, script } = await runShimWithDomainEntry(field, 'https://quora.com/');
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
    assertEquals(script.callCount(), 0);
    assertEquals(backend.calls.length, 0);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { type: string; param: string; message: string } };
    assertEquals(body.error.type, 'invalid_request_error');
    assertEquals(body.error.param, 'tools');
    assert(body.error.message.includes('Invalid domain'));
  });

  test(`${field} entry with http:// prefix rejects with 400`, async () => {
    const { result } = await runShimWithDomainEntry(field, 'http://example.com');
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string; message: string } };
    assertEquals(body.error.param, 'tools');
    assert(body.error.message.includes('Invalid domain'));
  });

  test(`${field} entry with a path rejects with 400`, async () => {
    const { result } = await runShimWithDomainEntry(field, 'example.com/some/path');
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string; message: string } };
    assertEquals(body.error.param, 'tools');
    assert(body.error.message.includes('Invalid domain'));
  });

  test(`${field} entry with a port rejects with 400`, async () => {
    const { result } = await runShimWithDomainEntry(field, 'example.com:8080');
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string; message: string } };
    assertEquals(body.error.param, 'tools');
  });

  test(`${field} entry with a query string rejects with 400`, async () => {
    const { result } = await runShimWithDomainEntry(field, 'example.com?q=1');
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
  });

  test(`${field} empty-string entry rejects with 400`, async () => {
    const { result } = await runShimWithDomainEntry(field, '');
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string; message: string } };
    assertEquals(body.error.param, 'tools');
  });

  test(`${field} whitespace-only entry rejects with 400 (no surface expansion via .trim())`, async () => {
    const { result } = await runShimWithDomainEntry(field, '   ');
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
  });

  test(`${field} non-string entry rejects with 400 (typed-but-not-string)`, async () => {
    const { result } = await runShimWithDomainEntry(field, null);
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string; message: string } };
    assertEquals(body.error.param, 'tools');
    // Non-string rejection mirrors `invalid_type` shape: message
    // describes what was expected vs got.
    assert(body.error.message.includes('Expected string'));
  });

  test(`${field} exceeding 100 entries rejects with 400 (matches OpenAI documented cap)`, async () => {
    const oversized = Array.from({ length: 101 }, (_, i) => `host${i}.example`);
    const { backend } = makeStubDeps();
    const shim = withResponsesWebSearchShim;
    const inv = makeInvocation({
      payload: {
        tools: [{ type: 'web_search', filters: { [field]: oversized } }],
      },
    });
    const script = scriptedRun([messageTurn('never reached', 0)]);
    const result = await shim(inv, makeGatewayCtx(), script.run);
    assert(result.type === 'api-error');
    assertEquals(result.status, 400);
    assertEquals(script.callCount(), 0);
    assertEquals(backend.calls.length, 0);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { type: string; param: string; message: string } };
    assertEquals(body.error.type, 'invalid_request_error');
    assertEquals(body.error.param, 'tools');
    assert(body.error.message.includes('at most 100'));
    assert(body.error.message.includes('101'));
  });

  test(`${field} exactly 100 entries is accepted (boundary inclusive)`, async () => {
    const exactly100 = Array.from({ length: 100 }, (_, i) => `host${i}.example`);
    makeStubDeps();
    const shim = withResponsesWebSearchShim;
    const inv = makeInvocation({
      payload: {
        tools: [{ type: 'web_search', filters: { [field]: exactly100 } }],
      },
    });
    const script = scriptedRun([messageTurn('done', 0)]);
    const result = await shim(inv, makeGatewayCtx(), script.run);
    assert(result.type === 'events');
    await collectFrames(result.events);
  });
}

test('mixed list with one prefixed entry names the offending index (no silent drop)', async () => {
  // Concrete regression: a client sending blocked_domains
  // ['reddit.com', 'https://quora.com/'] previously had `quora.com`
  // silently NOT blocked. Reject at the boundary so the violating
  // index is named.
  const { result } = await runShimMixedList('blocked_domains', ['reddit.com', 'https://quora.com/']);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string; message: string } };
  assertEquals(body.error.param, 'tools');
  assert(body.error.message.includes('quora.com'));
});

const runShimMixedList = async (
  field: 'allowed_domains' | 'blocked_domains',
  entries: unknown[],
) => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: { [field]: entries as unknown as string[] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  return { result, backend, script };
};

test('invalid search_context_size value rejects with 400 (no silent fall-through to provider default)', async () => {
  // `search_context_size` is a closed enum on the wire (low/medium/high
  // per openai-python `WebSearchTool.search_context_size`). An unknown
  // string used to fall through to the provider's own (smaller)
  // default — silently shrinking the result set. Reject at the
  // boundary so the misuse surfaces.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        { type: 'web_search', search_context_size: 'XXL' as 'low' },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { type: string; param: string; message: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'tools[].search_context_size');
  assert(body.error.message.includes('XXL'));
});

for (const field of ['external_web_access', 'search_content_types', 'return_token_budget'] as const) {
  test(`explicitly-set hosted ${field} is silently stripped (the function tool the shim forwards never carries it)`, async () => {
    // The shim replaces the hosted entry with its function tool; any
    // hosted-only field — including ones the shim has no opinion on —
    // drops out with the entry. Mirrors native: silently stripped.
    // Tests the request completes normally instead of being rejected
    // as a 400.
    makeStubDeps();
    const shim = withResponsesWebSearchShim;
    const fieldValue: Record<typeof field, unknown> = {
      external_web_access: false,
      search_content_types: ['image'],
      return_token_budget: 'unlimited',
    };
    const inv = makeInvocation({
      payload: {
        tools: [{ type: 'web_search', [field]: fieldValue[field] }],
      },
    });
    const script = scriptedRun([messageTurn('hello', 0)]);
    const result = await shim(inv, makeGatewayCtx(), script.run);
    assert(result.type === 'events');
    const events = eventPayloads(await collectFrames(result.events));
    assertEquals(events[events.length - 1].type, 'response.completed');
  });
}

test('array-shaped filters rejects with 400 (typeof null/[] === "object" guards must not no-op)', async () => {
  // `typeof []` is `'object'`, so a plain `typeof filtersField !==
  // 'object'` guard would let `filters: []` pass and then silently
  // no-op (reading `.allowed_domains` on an array yields undefined).
  // Per OpenAPI `WebSearchTool.filters` is object-or-null; reject
  // arrays at the boundary so the client sees the misuse instead of
  // a downstream filter behaving as if nothing was configured.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: [1, 2, 3] as unknown as { allowed_domains?: string[] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('never reached', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { message: string; param: string } };
  assert(body.error.message.includes('must be an object'));
  assert(body.error.message.includes('array'));
  // `param` must be exactly `tools` (not a sub-field), since
  // `tools[].filters` itself is the offending location.
  assertEquals(body.error.param, 'tools');
});

test('empty allowed_domains array is a no-op (not a misuse signal)', async () => {
  // Empty list is the explicit "no allow-list" shape; it's a valid
  // client input. Only a NON-empty list with all-malformed entries is
  // a misuse worth rejecting.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [{ type: 'web_search', filters: { allowed_domains: [] } }],
    },
  });
  const script = scriptedRun([messageTurn('done', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  await collectFrames(result.events);
});

test('null allowed_domains is a no-op (treated the same as omitted)', async () => {
  // Tool authors sometimes use `null` and `undefined` interchangeably
  // as the "field absent" signal; neither should reject.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        {
          type: 'web_search',
          filters: { allowed_domains: null as unknown as string[] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('done', 0)]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  await collectFrames(result.events);
});

// ── Domain filter blocks open ─────────────────────────────────────────

test('open blocked by domain filter never calls backend', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [{ type: 'web_search', filters: { blocked_domains: ['blocked.com'] } }],
    },
  });
  const script = scriptedRun([
    openCallTurn(0, 'call_o', 'https://blocked.com/page'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(backend.calls.length, 0);
  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  const text = (lastOutput as { output: string }).output;
  assert(text.includes('Blocked by tool filters'));
});

test('find blocked by domain filter emits wire-side find_in_page (not open_page) with the original url/pattern', async () => {
  // When a `find` op's URL is blocked or its fetch fails, the
  // resulting `web_search_call` item must keep `action.type:
  // 'find_in_page'` and carry the model's original url + pattern.
  // Switching to `open_page` would silently change `action.type`
  // mid-result and confuse clients that branch on it to render the
  // model's intent (e.g. a UI that draws a "searched inside <url>
  // for <pattern>" badge for find ops only).
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [{ type: 'web_search', filters: { blocked_domains: ['blocked.com'] } }],
    },
  });
  const script = scriptedRun([
    findCallTurn(0, 'call_f', 'https://blocked.com/page', 'needle'),
    messageTurn('done', 0),
  ]);

  const { frames } = await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(backend.calls.length, 0);
  // Wire-side: the synthesized output_item.done for the web_search_call
  // must carry `action.type: 'find_in_page'` with the original url and
  // pattern preserved.
  const wsDones = outputItemDoneEvents(frames).filter(
    e => (e.item as { type?: string }).type === 'web_search_call',
  );
  assertEquals(wsDones.length, 1);
  const item = wsDones[0].item as ResponsesOutputWebSearchCall;
  assert(item.action !== undefined);
  assertEquals(item.action.type, 'find_in_page');
  const findAction = item.action as Extract<typeof item.action, { type: 'find_in_page' }>;
  assertEquals(findAction.url, 'https://blocked.com/page');
  assertEquals(findAction.pattern, 'needle');
});

// ── find: no matches ──────────────────────────────────────────────────

test('find with no matches returns the no-matches text', async () => {
  makeStubDeps({
    providerOverrides: {
      async fetchPage(req) {
        return {
          type: 'ok',
          pages: req.urls.map(url => ({
            url,
            title: 'p',
            content: 'lorem ipsum dolor',
            truncated: false,
            fullContentBytes: 17,
          })),
          failures: [],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    findCallTurn(0, 'call_f', 'https://example.com/p', 'nonexistent'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  const text = (lastOutput as { output: string }).output;
  assert(text.includes('No matching `nonexistent` found on https://example.com/p.'));
});

// ── find: matches with context ────────────────────────────────────────

test('find with matches returns bracketed context', async () => {
  makeStubDeps({
    providerOverrides: {
      async fetchPage(req) {
        return {
          type: 'ok',
          pages: req.urls.map(url => ({
            url,
            title: 'p',
            content: 'prefix needle suffix',
            truncated: false,
            fullContentBytes: 20,
          })),
          failures: [],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    findCallTurn(0, 'call_f', 'https://example.com/p', 'needle'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  const text = (lastOutput as { output: string }).output;
  assert(text.includes('[needle]'));
  assert(text.includes('1 match for pattern: `needle`'));
});

// ── Truncation sentinel ───────────────────────────────────────────────

test('truncated page contents append the truncation sentinel', async () => {
  makeStubDeps({
    providerOverrides: {
      async fetchPage(req) {
        return {
          type: 'ok',
          pages: req.urls.map(url => ({
            url,
            title: 'p',
            content: 'short body',
            truncated: true,
            fullContentBytes: 99999,
          })),
          failures: [],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    openCallTurn(0, 'call_o', 'https://example.com/x'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  const text = (lastOutput as { output: string }).output;
  assert(text.includes('[Content truncated; full page is 99999 bytes.'));
});

// ── Multi-turn SSE merge invariants ──────────────────────────────────

test('multi-turn merge: output_index unique, sequence_number monotonic, response.created once', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    searchCallTurn(0, 'call_2', 'q2'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  const created = events.filter(e => e.type === 'response.created');
  assertEquals(created.length, 1);

  const inProgress = events.filter(e => e.type === 'response.in_progress');
  assertEquals(inProgress.length, 1);

  const completed = events.filter(e => e.type === 'response.completed');
  assertEquals(completed.length, 1);

  const seqs = events
    .map(e => (e as { sequence_number?: number }).sequence_number)
    .filter((n): n is number => typeof n === 'number');
  for (let i = 1; i < seqs.length; i++) {
    assert(seqs[i] > seqs[i - 1], `sequence_number must be strictly increasing (got ${seqs[i - 1]} then ${seqs[i]})`);
  }
  assertEquals(seqs[0], 0);

  const addedIndices = events
    .filter((e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }> => e.type === 'response.output_item.added')
    .map(e => e.output_index);
  // Contiguous from 0 — uniqueness alone would not catch a missing slot.
  const sorted = [...addedIndices].sort((a, b) => a - b);
  const expected = Array.from({ length: addedIndices.length }, (_, i) => i);
  assertEquals(sorted, expected);
});

// ── Upstream-reported model carries through every synthesized frame ──

// Wire mock for upstream `response.created` that announces a specific
// served model — distinct from the client's payload.model so we can
// prove the shim quotes upstream's served identity rather than the
// requested literal.
const mkResponseCreatedWithModel = (model: string, responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: { id: responseId, object: 'response', model, output: [], output_text: '', status: 'in_progress', error: null, incomplete_details: null },
  });

const mkResponseInProgressWithModel = (model: string, responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.in_progress',
    response: { id: responseId, object: 'response', model, output: [], output_text: '', status: 'in_progress', error: null, incomplete_details: null },
  });

const mkResponseCompletedWithModel = (model: string, responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: { id: responseId, object: 'response', model, output: [], output_text: '', status: 'completed', error: null, incomplete_details: null },
  });

test('synthesized response.created / completed quote the upstream-reported model, not ctx.payload.model', async () => {
  // Critical observability contract: clients build alerting against
  // the dated variant the upstream actually served (e.g.
  // gpt-5.4-2025-01-20). Substituting ctx.payload.model would silently
  // lie about the served identity. ctx.payload.model is 'gpt-5'
  // (resolved + alias-rewritten value); upstream serves
  // 'gpt-5.4-2025-01-20'. Every synthesized frame must mirror upstream.
  const SERVED_MODEL = 'gpt-5.4-2025-01-20';
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { model: 'gpt-5' } });

  const script = scriptedRun([
    [
      mkResponseCreatedWithModel(SERVED_MODEL),
      mkResponseInProgressWithModel(SERVED_MODEL),
      mkFunctionCallAdded(0, 'call_1', SHIM_TOOL_NAME),
      mkFunctionCallArgsDone(0, JSON.stringify({ search_query: [{ q: 'hi' }] })),
      mkFunctionCallDone(0, 'call_1', SHIM_TOOL_NAME, JSON.stringify({ search_query: [{ q: 'hi' }] })),
      mkResponseCompletedWithModel(SERVED_MODEL),
    ],
    [
      mkResponseCreatedWithModel(SERVED_MODEL),
      mkResponseInProgressWithModel(SERVED_MODEL),
      mkMessageAdded(0),
      mkMessageDone(0, 'done'),
      mkResponseCompletedWithModel(SERVED_MODEL),
    ],
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  const created = events.find(e => e.type === 'response.created') as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  const inProgress = events.find(e => e.type === 'response.in_progress') as Extract<ResponsesStreamEvent, { type: 'response.in_progress' }>;
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;
  assertEquals(created.response.model, SERVED_MODEL);
  assertEquals(inProgress.response.model, SERVED_MODEL);
  assertEquals(completed.response.model, SERVED_MODEL);
});

test('synthesized response.failed (upstream error mid-stream) quotes the upstream-reported model', async () => {
  const SERVED_MODEL = 'gpt-5.4-2025-01-20';
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { model: 'gpt-5' } });

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: ProtocolFrame<ResponsesStreamEvent>[] = [
        mkResponseCreatedWithModel(SERVED_MODEL),
        mkResponseInProgressWithModel(SERVED_MODEL),
        mkFunctionCallAdded(0, 'call_1', SHIM_TOOL_NAME),
        mkFunctionCallArgsDone(0, JSON.stringify({ search_query: [{ q: 'hi' }] })),
        mkFunctionCallDone(0, 'call_1', SHIM_TOOL_NAME, JSON.stringify({ search_query: [{ q: 'hi' }] })),
        mkResponseCompletedWithModel(SERVED_MODEL),
      ];
      const iterable: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of frames) yield f;
      })();
      return { type: 'events', events: iterable, modelIdentity: testTelemetryModelIdentity };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"error":"down"}'),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const failed = events[events.length - 1] as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failed.type, 'response.failed');
  assertEquals(failed.response.model, SERVED_MODEL);
});

test('shim refuses to synthesize a response envelope when upstream response.created has no model', async () => {
  // No-fallback contract: a missing model on upstream's first
  // response.created is a protocol violation. The `ensureModel()`
  // invariant throws from inside `consumeTurnStreaming`; the throw
  // surfaces through the events generator to the source responder
  // (which reports it upward) rather than being silently swallowed
  // or papered over with `ctx.payload.model`.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { model: 'gpt-5' } });

  const modelless = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: { id: 'upstream_x', object: 'response', output: [], output_text: '', status: 'in_progress' } as never,
  });
  const script = scriptedRun([[modelless, mkResponseCompleted()]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  let thrown: unknown = undefined;
  try {
    for await (const _ of result.events) { /* drain */ }
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error);
  // Either the consume-turn `ensureModel` throw OR the synthesize-
  // envelope throw — both signal the same "no model captured" state.
  assert(/did not report a `model`|never reported a `model`/.test(thrown.message));
});

test('upstream response.created with no `id` field is tolerated (downstream uses the shim-synthesized id regardless)', async () => {
  // The shim never quotes upstream's `id` downstream — every
  // synthesized envelope carries the shim's own `resp_shim_<uuid>`
  // identity. So a missing id on upstream's `response.created` is
  // harmless; the downstream response still gets a valid id.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { model: 'gpt-5' } });

  const idless = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: { model: 'gpt-5', object: 'response', output: [], output_text: '', status: 'in_progress' } as never,
  });
  const script = scriptedRun([[idless, mkResponseCompleted()]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const created = events.find(e => e.type === 'response.created') as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  assert(created.response.id.startsWith('resp_shim_'));
});

test('synthesized response.created / completed quote the once-per-request synthesized id (not the upstream id, not a fresh per-event id)', async () => {
  // Upstream's id is irrelevant downstream — the shim generates a
  // single `resp_shim_<uuid>` at activation and quotes it on every
  // synthesized envelope (created, in_progress, completed). One
  // stable id is what clients correlate against across the shim's
  // multi-turn response.
  const UPSTREAM_ID = 'resp_abc123def456';
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    [
      mkResponseCreated(UPSTREAM_ID),
      mkResponseInProgress(UPSTREAM_ID),
      mkMessageAdded(0),
      mkMessageDone(0, 'done'),
      mkResponseCompleted(undefined, UPSTREAM_ID),
    ],
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  const created = events.find(e => e.type === 'response.created') as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  const inProgress = events.find(e => e.type === 'response.in_progress') as Extract<ResponsesStreamEvent, { type: 'response.in_progress' }>;
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;
  assert(created.response.id.startsWith('resp_shim_'));
  assertEquals(inProgress.response.id, created.response.id);
  assertEquals(completed.response.id, created.response.id);
  // Upstream's id is not what the wire carries.
  assertFalse(created.response.id === UPSTREAM_ID);
});

test('synthesized terminal id stays constant across multi-turn upstream id rotation', async () => {
  // Upstream re-encrypts response.id per turn (turn-N's
  // response.created and terminal frames can carry a different id
  // than turn-1's). The shim's synthesized id is generated ONCE per
  // request, so cross-turn synthesis quotes the same value end to
  // end regardless of what upstream rotates to.
  const TURN1_ID = 'resp_turn1_aaa';
  const TURN2_ID = 'resp_turn2_bbb_rotated';
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    [
      mkResponseCreated(TURN1_ID),
      mkResponseInProgress(TURN1_ID),
      mkFunctionCallAdded(0, 'call_1', SHIM_TOOL_NAME),
      mkFunctionCallArgsDone(0, JSON.stringify({ search_query: [{ q: 'q' }] })),
      mkFunctionCallDone(0, 'call_1', SHIM_TOOL_NAME, JSON.stringify({ search_query: [{ q: 'q' }] })),
      mkResponseCompleted(undefined, TURN1_ID),
    ],
    [
      mkResponseCreated(TURN2_ID),
      mkResponseInProgress(TURN2_ID),
      mkMessageAdded(0),
      mkMessageDone(0, 'done'),
      mkResponseCompleted(undefined, TURN2_ID),
    ],
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const created = events.find(e => e.type === 'response.created') as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;
  assert(created.response.id.startsWith('resp_shim_'));
  // Same shim-synthesized id end-to-end; neither upstream turn id
  // leaks downstream.
  assertEquals(completed.response.id, created.response.id);
  assertFalse(completed.response.id === TURN1_ID);
  assertFalse(completed.response.id === TURN2_ID);
});

// ── Usage accumulation across multiple iterations ─────────────────────

test('usage accumulates across three iterations', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  const turnWithUsage = (
    callId: string,
    inTok: number,
    outTok: number,
  ): ScriptedTurn => {
    const args = JSON.stringify({ search_query: [{ q: callId }] });
    return [
      mkResponseCreated(),
      mkResponseInProgress(),
      mkFunctionCallAdded(0, callId, SHIM_TOOL_NAME),
      mkFunctionCallArgsDone(0, args),
      mkFunctionCallDone(0, callId, SHIM_TOOL_NAME, args),
      mkResponseCompleted({ input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok }),
    ];
  };

  const finalTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompleted({ input_tokens: 5, output_tokens: 2, total_tokens: 7 }),
  ];

  const script = scriptedRun([
    turnWithUsage('c1', 100, 50),
    turnWithUsage('c2', 200, 30),
    finalTurn,
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const completed = events.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.completed' }> => e.type === 'response.completed');
  assert(completed !== undefined);
  assertEquals(completed.response.usage?.input_tokens, 305);
  assertEquals(completed.response.usage?.output_tokens, 82);
  assertEquals(completed.response.usage?.total_tokens, 387);
});

test('usage cached_tokens reported on one turn carries through (last-turn omission does not zero it out)', async () => {
  // Internal sums treat missing fields as 0; the wire output preserves
  // any field at least one turn observed. Turn 1 reports cached_tokens;
  // turn 2 omits it. Final usage must still surface cached_tokens
  // (turn 1's value).
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  const turn1Args = JSON.stringify({ search_query: [{ q: 'q1' }] });
  const turn1: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_1', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, turn1Args),
    mkFunctionCallDone(0, 'call_1', SHIM_TOOL_NAME, turn1Args),
    mkResponseCompleted({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 7 },
    }),
  ];
  const turn2: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    // No input_tokens_details on this turn.
    mkResponseCompleted({ input_tokens: 50, output_tokens: 10, total_tokens: 60 }),
  ];

  const result = await shim(inv, makeGatewayCtx(), scriptedRun([turn1, turn2]).run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const completed = events.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.completed' }> => e.type === 'response.completed');
  assert(completed !== undefined);
  assertEquals(completed.response.usage?.input_tokens, 150);
  assertEquals(completed.response.usage?.output_tokens, 60);
  assertEquals(completed.response.usage?.total_tokens, 210);
  // cached_tokens is treated as 0 for the missing-turn-2 side; the
  // sum is 7 + 0 = 7 and the field is present on the wire.
  assertEquals(completed.response.usage?.input_tokens_details, { cached_tokens: 7 });
});

test('usage cached_tokens never reported on any turn is omitted from wire (no fabricated zero)', async () => {
  // Sparse output: a field that no turn ever reported is not emitted
  // as `cached_tokens: 0`. The wire shape matches what a native
  // upstream that doesn't track caching would produce.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  const turn1Args = JSON.stringify({ search_query: [{ q: 'q1' }] });
  const turn1: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_1', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, turn1Args),
    mkFunctionCallDone(0, 'call_1', SHIM_TOOL_NAME, turn1Args),
    mkResponseCompleted({ input_tokens: 100, output_tokens: 50, total_tokens: 150 }),
  ];
  const turn2: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompleted({ input_tokens: 50, output_tokens: 10, total_tokens: 60 }),
  ];

  const result = await shim(inv, makeGatewayCtx(), scriptedRun([turn1, turn2]).run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const completed = events.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.completed' }> => e.type === 'response.completed');
  assert(completed !== undefined);
  assertEquals(completed.response.usage?.input_tokens, 150);
  assertEquals(completed.response.usage?.input_tokens_details, undefined);
  assertEquals(completed.response.usage?.output_tokens_details, undefined);
});

test('next-turn function_call echo always carries the canonical re-stringified shim call args (single shape unified with client-roundtrip)', async () => {
  // The dispatcher always overwrites the intercepted call's
  // arguments with the canonical re-stringified form, regardless of
  // whether the upstream string was already valid JSON. This
  // unifies the in-session multi-turn echo with the client-roundtrip
  // pairs produced by `transformInputItemsForWebSearch` (which build args
  // from structured IR data, not a wire string), so upstream sees
  // exactly one `arguments` shape regardless of how the pair
  // re-entered the conversation. Trailing-comma input is the
  // strongest case — without this rewrite a chat-completions
  // upstream would 400 on the broken raw string — but the same
  // canonical form is also used for already-valid input.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  // Trailing-comma JSON survives jsonrepair but is not valid strict JSON.
  const brokenArgs = '{"search_query":[{"q":"q"}],}';
  const brokenTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_broken', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, brokenArgs),
    mkFunctionCallDone(0, 'call_broken', SHIM_TOOL_NAME, brokenArgs),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([brokenTurn, messageTurn('done', 0)]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  const fc = input.find(i => i.type === 'function_call') as
    | { type: 'function_call'; arguments: string }
    | undefined;
  assert(fc !== undefined);
  // Canonical JSON form (JSON.stringify of the parsed object) — no
  // trailing comma, valid strict JSON.
  assertEquals(fc.arguments, '{"search_query":[{"q":"q"}]}');
});

test('upstream sends bare `error` frame BEFORE any response.created: shim throws from the events iterator (no synthetic response.failed with empty identity)', async () => {
  // A bare `{type:'error'}` arriving before any `response.created`
  // produces no captured identity (id / model). Synthesizing a
  // `response.failed` envelope would require those fields. The
  // synthesizer throws instead of inventing values; the throw
  // escapes the events generator and is surfaced upward by the
  // source responder. The unreachable-in-practice path stays
  // honest about the upstream protocol violation rather than
  // silently lying about the served identity.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const errorOnlyTurn: ScriptedTurn = [
    eventFrame<ResponsesStreamEvent>({
      type: 'error',
      message: 'upstream dropped before response shell',
    }),
  ];
  const script = scriptedRun([errorOnlyTurn]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  let thrown: unknown = undefined;
  try {
    for await (const _ of result.events) { /* drain */ }
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error);
});

test('upstream sends bare `error` frame AFTER response.created: shim emits response.failed with synthesized id + last-seen model', async () => {
  // When model is captured before the bare error arrives, the shim
  // can synthesize a wire-valid `response.failed` envelope. The
  // synthesized id is the shim's own (`resp_shim_<uuid>`), and the
  // model is the last-seen upstream model.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const createdWith = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: {
      id: 'resp_captured_id_xyz',
      object: 'response',
      model: 'gpt-5.4-2025-01-20',
      output: [],
      status: 'in_progress',
      error: null,
      incomplete_details: null,
    } as ResponsesResult,
  });
  const script = scriptedRun([[
    createdWith,
    eventFrame<ResponsesStreamEvent>({
      type: 'error',
      message: 'mid-stream upstream blew up',
      code: 'server_error',
    }),
  ]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const failed = events[events.length - 1] as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failed.type, 'response.failed');
  assert(failed.response.id.startsWith('resp_shim_'));
  assertEquals(failed.response.model, 'gpt-5.4-2025-01-20');
  assertEquals(failed.response.status, 'failed');
  assertEquals(failed.response.error?.message, 'mid-stream upstream blew up');
  // Upstream-supplied code carries through verbatim.
  assertEquals(failed.response.error?.code, 'server_error');
  // No synthetic `type` field — the OpenAPI ResponsesError schema
  // defines only `{code, message}` and the bare `error` upstream frame
  // doesn't carry a `type` to forward.
  assertFalse('type' in (failed.response.error as object));
});

test('upstream iterator rejects before yielding any frame: shim surfaces the throw through the events iterator', async () => {
  // An iterator that throws synchronously on `.next()` (malformed
  // SSE JSON, reader rejection, network reset mid-handshake) yields
  // no identity capture. The synthesizer can't build a wire-valid
  // failed envelope, so the throw escapes the events generator and
  // the source responder reports it upward — same channel as any
  // other mid-stream failure with no captured identity.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const failingIterator: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
    throw new Error('malformed SSE JSON at byte 42');
    yield undefined as never;
  })();
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => ({
    type: 'events',
    events: failingIterator,
    modelIdentity: testTelemetryModelIdentity,
  });

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  let thrown: unknown = undefined;
  try {
    for await (const _ of result.events) { /* drain */ }
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error);
});

test('pathological upstream emitting frames without response.created: shim eventually completes without identity capture (no infinite-loop)', async () => {
  // The previous preflight enforced a 100-frame budget here. With
  // preflight removed, indexed-unknown frames flow through
  // consume-turn directly. The protective behavior now relies on
  // upstream eventually terminating (the iterator returns); when it
  // does without ever emitting `response.created`, identity stays
  // null and any envelope synthesis throws. Test the well-behaved
  // bounded case: 5 noisy indexed frames then iterator returns
  // (matches a malformed-but-finite upstream that drops without
  // ever sending a shell).
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const noisyIterator: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
    for (let i = 0; i < 5; i++) {
      yield eventFrame<ResponsesStreamEvent>({
        type: 'response.unknown_future_call.in_progress',
        output_index: i,
        item_id: `unk_${i}`,
      } as unknown as ResponsesStreamEvent);
    }
  })();
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => ({
    type: 'events',
    events: noisyIterator,
    modelIdentity: testTelemetryModelIdentity,
  });

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  let thrown: unknown = undefined;
  try {
    for await (const _ of result.events) { /* drain */ }
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error);
});

test('turn-1 iterator throws AFTER response.created: synthesizes response.failed with synthesized id + last-seen model', async () => {
  // After identity (model) is captured, a mid-stream throw is
  // funneled through the response.failed synthesizer so the
  // downstream wire mirrors a native upstream's mid-stream drop
  // instead of escaping uncaught to a gateway internal_error.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const failingMidStream: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
    yield mkResponseCreated('upstream_mid');
    throw new Error('connection reset by peer');
  })();
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => ({
    type: 'events',
    events: failingMidStream,
    modelIdentity: testTelemetryModelIdentity,
  });

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const terminal = events[events.length - 1];
  assertEquals(terminal.type, 'response.failed');
  const failed = terminal as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failed.response.status, 'failed');
  assert(failed.response.id.startsWith('resp_shim_'));
  assertEquals(failed.response.model, 'test-model');
  assertEquals(failed.response.error?.code, 'server_error');
  assert(failed.response.error?.message.includes('connection reset by peer'));
  assert(failed.response.error?.message.includes('Upstream stream failed mid-response'));
  // No synthetic `type` per the spec ResponsesError schema (only
  // `{code, message}`).
  assertFalse('type' in (failed.response.error as object));
});

test('turn-2 iterator throws: synthesizes response.failed with captured id/model from turn-1', async () => {
  // Same protection on turn-2+ iterators (drained by `drainTurnStreaming`).
  // A throw after the multi-turn loop has crossed run() boundaries
  // must still funnel through the `response.failed` synthesizer.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const turn1 = searchCallTurn(0, 'call_1', 'q1');
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of turn1) yield f;
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    const failingTurn2: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
      yield mkResponseCreated('upstream_test');
      throw new Error('upstream parser exploded');
    })();
    return { type: 'events', events: failingTurn2, modelIdentity: testTelemetryModelIdentity };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const terminal = events[events.length - 1];
  assertEquals(terminal.type, 'response.failed');
  const failed = terminal as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failed.response.error?.code, 'server_error');
  assert(failed.response.error?.message.includes('upstream parser exploded'));
  assert(failed.response.error?.message.includes('Upstream stream failed mid-response'));
  assertFalse('type' in (failed.response.error as object));
});

test('consume-turn finishes without identity AND without bare-error-pre-shell: shim throws from synthesizer (no silent invented identity)', async () => {
  // A `response.completed` arriving without a preceding
  // `response.created` reaches the terminal completed state without
  // capturing identity. Synthesizing a completed envelope would
  // require id + model the shim never observed — `ensureModel` /
  // `ensureResponseId` throw instead of inventing values, and the
  // throw escapes the events generator.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const malformed: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
    yield mkResponseCompleted();
  })();
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => ({
    type: 'events',
    events: malformed,
    modelIdentity: testTelemetryModelIdentity,
  });

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  let thrown: unknown = undefined;
  try {
    for await (const _ of result.events) { /* drain */ }
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error);
});

// ── Snapshot pass-through preserves upstream-owned envelope fields ──

test('snapshot pass-through: upstream tools/tool_choice/temperature/parallel_tool_calls/reasoning/service_tier survive synthesized response.created + .completed', async () => {
  // The shim used to build fresh ResponsesResult shells with hard-
  // coded {id, object, model, status, output, output_text, [usage]}
  // and drop everything else upstream sent. Real upstream wire frames
  // carry parallel_tool_calls, tool_choice, tools, temperature, top_p,
  // reasoning, service_tier, truncation, metadata, instructions,
  // max_output_tokens, previous_response_id, created_at, … (see
  // captured fixture at openai-dotnet/tests/SessionRecords/
  // ResponsesToolTests/WebSearchCallAsync.json:65-223). Snapshot-and-
  // overlay preserves all of them.
  const upstreamSnapshot = {
    id: 'upstream_full',
    object: 'response',
    model: 'gpt-5.4-2025-01-20',
    output: [],
    status: 'in_progress',
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [{ type: 'web_search' }],
    temperature: 0.7,
    top_p: 1,
    reasoning: { effort: 'medium' },
    service_tier: 'default',
    truncation: 'disabled',
    metadata: { trace_id: 'abc' },
    instructions: 'Be helpful',
    max_output_tokens: 4096,
    previous_response_id: 'resp_prev_xyz',
    created_at: 1735689600,
    error: null,
    incomplete_details: null,
  };
  const createdWith = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: upstreamSnapshot as ResponsesResult,
  });
  const completedWith = eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      ...upstreamSnapshot,
      status: 'completed',
      // Native upstreams typically add completed_at on the terminal frame.
      completed_at: 1735689700,
    } as ResponsesResult,
  });
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([[createdWith, mkMessageAdded(0), mkMessageDone(0, 'done'), completedWith]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const created = events.find(e => e.type === 'response.created') as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;

  // Every preserved field arrives on both the in-progress (response.created)
  // synthesized envelope and the final completed envelope.
  for (const frame of [created.response, completed.response] as unknown as Array<Record<string, unknown>>) {
    assertEquals(frame.parallel_tool_calls, true);
    assertEquals(frame.tool_choice, 'auto');
    assertEquals(frame.tools, [{ type: 'web_search' }]);
    assertEquals(frame.temperature, 0.7);
    assertEquals(frame.top_p, 1);
    assertEquals(frame.reasoning, { effort: 'medium' });
    assertEquals(frame.service_tier, 'default');
    assertEquals(frame.truncation, 'disabled');
    assertEquals(frame.metadata, { trace_id: 'abc' });
    assertEquals(frame.instructions, 'Be helpful');
    assertEquals(frame.max_output_tokens, 4096);
    assertEquals(frame.previous_response_id, 'resp_prev_xyz');
    assertEquals(frame.created_at, 1735689600);
  }
  // Terminal-only fields appear on the terminal envelope (refreshed from
  // upstream's terminal snapshot).
  assertEquals((completed.response as unknown as Record<string, unknown>).completed_at, 1735689700);
});

test('snapshot pass-through: synthesized response.failed (mid-stream upstream error) preserves upstream-owned envelope fields from turn 1 snapshot', async () => {
  // The error path builds its `response.failed` envelope from the
  // shim's accumulated state but still spreads the captured snapshot
  // so client tool_choice / tools / reasoning visibility survives even
  // when a later turn fails.
  const upstreamSnapshot = {
    id: 'upstream_full',
    object: 'response',
    model: 'gpt-5',
    output: [],
    status: 'in_progress',
    tools: [{ type: 'web_search' }],
    reasoning: { effort: 'high' },
    error: null,
    incomplete_details: null,
  };
  const createdWith = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: upstreamSnapshot as ResponsesResult,
  });
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const wsArgs = JSON.stringify({ search_query: [{ q: 'q' }] });
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        yield createdWith;
        yield mkFunctionCallAdded(0, 'call_1', SHIM_TOOL_NAME);
        yield mkFunctionCallArgsDone(0, wsArgs);
        yield mkFunctionCallDone(0, 'call_1', SHIM_TOOL_NAME, wsArgs);
        yield eventFrame<ResponsesStreamEvent>({
          type: 'response.completed',
          response: { ...upstreamSnapshot, status: 'completed' } as ResponsesResult,
        });
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"error":"down"}'),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const failed = events.find(e => e.type === 'response.failed') as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assert(failed !== undefined);
  const r = failed.response as unknown as Record<string, unknown>;
  assertEquals(r.tools, [{ type: 'web_search' }]);
  assertEquals(r.reasoning, { effort: 'high' });
});

test('snapshot pass-through: snapshot fields like completed_at flow through verbatim onto every synthesized envelope (the shim only overrides id/model/status/output/usage)', async () => {
  // Synthesizers spread upstream's snapshot in full and override only
  // the shim-owned fields. Snapshot pass-through is the contract —
  // a turn-2 synthesizer reads turn-1's snapshot until refreshed by
  // a later upstream frame, so `completed_at`-style fields can ride
  // through onto a multi-turn failed envelope. Clients reading
  // `status === 'completed'` already know `completed_at` is only
  // semantically meaningful on completed responses; the wire shape
  // stays whatever upstream produced.
  const turn1Snapshot = {
    id: 'upstream_full',
    object: 'response',
    model: 'gpt-5',
    output: [],
    status: 'in_progress',
    error: null,
    incomplete_details: null,
  };
  const turn1Created = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: turn1Snapshot as ResponsesResult,
  });
  const turn1Completed = eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      ...turn1Snapshot,
      status: 'completed',
      completed_at: 1735689700,
    } as unknown as ResponsesResult,
  });
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const wsArgs = JSON.stringify({ search_query: [{ q: 'q' }] });
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        yield turn1Created;
        yield mkFunctionCallAdded(0, 'call_1', SHIM_TOOL_NAME);
        yield mkFunctionCallArgsDone(0, wsArgs);
        yield mkFunctionCallDone(0, 'call_1', SHIM_TOOL_NAME, wsArgs);
        yield turn1Completed;
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"error":"down"}'),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const failed = events.find(e => e.type === 'response.failed') as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assert(failed !== undefined);
  const r = failed.response as unknown as Record<string, unknown>;
  // Pass-through contract: snapshot's completed_at flows through
  // verbatim — the wire envelope quotes upstream's emission.
  assertEquals(r.completed_at, 1735689700);
  assertEquals(r.status, 'failed');
});

test('snapshot strip: emitFinalCompleted re-adds completed_at when upstream supplied it on the terminal frame', async () => {
  // The strip in `overlayOnSnapshot` is universal (applies to all
  // synthesizers); `emitFinalCompleted` re-attaches `completed_at`
  // from the captured snapshot so a genuine `response.completed`
  // surfaces upstream's timestamp.
  const upstreamSnapshot = {
    id: 'upstream_full',
    object: 'response',
    model: 'gpt-5',
    output: [],
    status: 'in_progress',
    error: null,
    incomplete_details: null,
  };
  const turn1Created = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: upstreamSnapshot as ResponsesResult,
  });
  const turn1Completed = eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      ...upstreamSnapshot,
      status: 'completed',
      completed_at: 1735689700,
    } as unknown as ResponsesResult,
  });
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([[
    turn1Created,
    mkMessageAdded(0),
    mkMessageDone(0, 'hi'),
    turn1Completed,
  ]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;
  assert(completed !== undefined);
  const r = completed.response as unknown as Record<string, unknown>;
  assertEquals(r.completed_at, 1735689700);
});

test('snapshot pass-through: incomplete_details: null on the captured snapshot propagates verbatim to the synthesized response.completed', async () => {
  // Native upstreams sometimes emit `incomplete_details: null` on a
  // `response.completed` (Pydantic round-trips `None` for explicit
  // null vs. omitted-field distinctions). The shim must preserve the
  // exact field state — coercing `null` to omitted (or vice versa)
  // would break clients that probe for the field's presence rather
  // than its truthiness.
  const upstreamSnapshot = {
    id: 'upstream_full',
    object: 'response',
    model: 'gpt-5',
    output: [],
    status: 'in_progress',
    error: null,
    incomplete_details: null,
  };
  const turn1Created = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: upstreamSnapshot as ResponsesResult,
  });
  const turn1Completed = eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      ...upstreamSnapshot,
      status: 'completed',
      incomplete_details: null,
    } as unknown as ResponsesResult,
  });
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([[
    turn1Created,
    mkMessageAdded(0),
    mkMessageDone(0, 'hi'),
    turn1Completed,
  ]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;
  assert(completed !== undefined);
  const r = completed.response as unknown as Record<string, unknown>;
  // Field present and explicitly `null` — neither coerced to undefined
  // nor dropped.
  assert('incomplete_details' in r);
  assertEquals(r.incomplete_details, null);
});

test('success-path synth envelopes carry spec-required `error: null` and `incomplete_details: null`', async () => {
  // The Responses OpenAPI spec marks `error` and `incomplete_details`
  // REQUIRED on every Response (both nullable). Reference:
  // https://github.com/openai/openai-openapi/blob/master/openapi.yaml
  // `Response.required` lists both. Typed-SDK clients parse against
  // that contract and reject envelopes missing the keys; the shim's
  // `overlayOnSnapshot` therefore defaults both to null after stripping
  // terminal-only snapshot fields, then lets explicit overlays (e.g.
  // `response.failed.error`, real terminal `incomplete_details`) win.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  // Single turn, pure message, no tool call — exercises the
  // emitFinalCompleted success path through overlayOnSnapshot.
  const script = scriptedRun([messageTurn('hi')]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  // Every synthesized envelope (created, in_progress, completed) MUST
  // carry both fields as null.
  for (const frameType of ['response.created', 'response.in_progress', 'response.completed'] as const) {
    const ev = events.find(e => e.type === frameType) as Extract<ResponsesStreamEvent, { type: typeof frameType }>;
    assert(ev !== undefined, `expected ${frameType}`);
    const r = ev.response as unknown as Record<string, unknown>;
    assert('error' in r, `${frameType} missing 'error' key`);
    assertEquals(r.error, null);
    assert('incomplete_details' in r, `${frameType} missing 'incomplete_details' key`);
    assertEquals(r.incomplete_details, null);
  }
});

// ── output_text is never synthesized ─────────────────────────────────

test('shim rebuilds `output_text` on terminal envelopes from the accumulated message items (matches openai-python Response.output_text)', async () => {
  // SDKs derive `output_text` from the `output` array. Per-turn
  // upstream `output_text` on a terminal frame only describes that
  // one turn, so on multi-turn shim responses the snapshot value
  // would desync from the cross-turn aggregated `output`. The shim
  // rebuilds the alias from `accumulatedOutput` and overrides the
  // snapshot's value on the terminal envelope.
  const omitOutputText = (responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
    eventFrame<ResponsesStreamEvent>({
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        model: 'test-model',
        output: [],
        status: 'completed',
        error: null,
        incomplete_details: null,
      },
    });
  const omitOutputTextCreated = (responseId = 'upstream_test'): ProtocolFrame<ResponsesStreamEvent> =>
    eventFrame<ResponsesStreamEvent>({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        model: 'test-model',
        output: [],
        status: 'in_progress',
        error: null,
        incomplete_details: null,
      },
    });
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const turn: ScriptedTurn = [
    omitOutputTextCreated(),
    mkMessageAdded(0),
    mkMessageDone(0, 'hi there'),
    omitOutputText(),
  ];
  const script = scriptedRun([turn]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const completed = events.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.completed' }> => e.type === 'response.completed');
  assert(completed !== undefined);
  assertEquals((completed.response as unknown as { output_text: string }).output_text, 'hi there');
});

test('upstream-emitted `output_text` on in-progress envelopes flows through verbatim from the snapshot', async () => {
  // Snapshot pass-through contract: every upstream field flows
  // through unchanged unless the shim explicitly overrides it.
  // `output_text` on in-progress envelopes is just the snapshot's
  // value — terminal envelopes get a separately-rebuilt
  // `output_text` aggregated across turns (covered by the dedicated
  // rebuildOutputText test below).
  const createdWithStaleText = eventFrame<ResponsesStreamEvent>({
    type: 'response.created',
    response: {
      id: 'resp_stale',
      object: 'response',
      model: 'test-model',
      output: [],
      status: 'in_progress',
      output_text: 'snapshot output_text',
      error: null,
      incomplete_details: null,
    } as ResponsesResult,
  });
  const inProgressWithStaleText = eventFrame<ResponsesStreamEvent>({
    type: 'response.in_progress',
    response: {
      id: 'resp_stale',
      object: 'response',
      model: 'test-model',
      output: [],
      status: 'in_progress',
      output_text: 'snapshot output_text',
      error: null,
      incomplete_details: null,
    } as ResponsesResult,
  });
  const completedFrame = eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      id: 'resp_stale',
      object: 'response',
      model: 'test-model',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'real result' }] },
      ],
      status: 'completed',
      error: null,
      incomplete_details: null,
    } as ResponsesResult,
  });
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([[
    createdWithStaleText,
    inProgressWithStaleText,
    mkMessageAdded(0),
    mkMessageDone(0, 'real result'),
    completedFrame,
  ]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const created = events.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.created' }> => e.type === 'response.created');
  const inProgress = events.find((e): e is Extract<ResponsesStreamEvent, { type: 'response.in_progress' }> => e.type === 'response.in_progress');
  assert(created !== undefined);
  assert(inProgress !== undefined);
  // Snapshot's output_text flows through verbatim on in-progress
  // envelopes — the shim only overrides id/model/status/output.
  assertEquals((created.response as unknown as { output_text?: string }).output_text, 'snapshot output_text');
  assertEquals((inProgress.response as unknown as { output_text?: string }).output_text, 'snapshot output_text');
});

// ── finalMetadata follows the latest turn's modelIdentity ──────────────

test('finalMetadata resolves with the LATEST turn modelIdentity, not turn 1', async () => {
  // The source responder reads modelIdentity from finalMetadata when
  // recording usage / performance. A multi-turn run where upstream
  // serves a different dated variant on a later turn (Copilot
  // raw-variant selection) must report the latest variant — passing
  // through firstResult.finalMetadata would freeze it to turn 1's
  // modelKey.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    const frames = runCalls === 1
      ? searchCallTurn(0, 'call_1', 'q1')
      : messageTurn('done', 0);
    const iterable: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
      for (const f of frames) yield f;
    })();
    return {
      type: 'events',
      events: iterable,
      // Distinct modelKey per turn so we can prove which one
      // finalMetadata observed.
      modelIdentity: {
        model: 'gpt-5',
        upstream: 'test-upstream',
        modelKey: `turn-${runCalls}-key`,
        cost: null,
      },
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  // Drain so the multi-turn loop completes and finalMetadata resolves.
  await collectFrames(result.events);
  assert(result.finalMetadata !== undefined);
  const meta = await result.finalMetadata;
  assertEquals(meta.modelIdentity.modelKey, 'turn-2-key');
});

// ── Results are always included on web_search_call items ─────────────

test('synthesized web_search_call (search action) carries both `query` (singular) and `queries` (plural) for SDK compat', async () => {
  // openai-python `ActionSearch` declares `query: str` as REQUIRED
  // (no default). openai-go and newer codex variants prefer
  // `queries: list[str]`. Emit BOTH so every typed SDK reads a
  // populated value regardless of which field its model declares.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'who invented graphql'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const doneEvents = outputItemDoneEvents(await collectFrames(result.events));
  const wsCallDone = doneEvents.find(e => e.item.type === 'web_search_call');
  assert(wsCallDone !== undefined);
  const item = wsCallDone.item as ResponsesOutputWebSearchCall;
  assertEquals(item.action?.type, 'search');
  const action = item.action as { type: 'search'; query?: string; queries?: string[] };
  assertEquals(action.query, 'who invented graphql');
  assertEquals(action.queries, ['who invented graphql']);
});

test('response.output_item.added for web_search_call omits action (mirrors native — action populated only on .done)', async () => {
  // Native upstreams omit `action` on the `.added` half and populate
  // it only on `.done` once the operation completes. The shim
  // follows suit; clients that render action.* read from the done
  // frame.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'who invented graphql'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const wsAdded = events.find(
    (e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }> =>
      e.type === 'response.output_item.added'
      && (e.item as { type?: string }).type === 'web_search_call',
  );
  const wsDone = events.find(
    (e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> =>
      e.type === 'response.output_item.done'
      && (e.item as { type?: string }).type === 'web_search_call',
  );
  assert(wsAdded !== undefined);
  assert(wsDone !== undefined);
  const addedItem = wsAdded.item as ResponsesOutputWebSearchCall;
  const doneItem = wsDone.item as ResponsesOutputWebSearchCall;
  assertEquals(addedItem.status, 'in_progress');
  assertEquals(doneItem.status, 'completed');
  assertFalse('action' in addedItem);
  assert(doneItem.action !== undefined);
  assertEquals(addedItem.results, undefined);
});

test('open with invalid ref_id: done frame carries action.type="search" with the bad ref in queries', async () => {
  // Invalid ref_id has no URL to ride on `open_page`, so the done
  // frame carries `{type:'search', queries:[ref_id]}` (the model and
  // typed-SDK clients render a coherent intent). The added frame
  // omits `action` regardless, matching native.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const invalidRef = 'turn_4_ws_0';
  const argsJson = JSON.stringify({ open: [{ ref_id: invalidRef }] });
  const turn1: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_open', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, argsJson),
    mkFunctionCallDone(0, 'call_open', SHIM_TOOL_NAME, argsJson),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([turn1, messageTurn('done', 0)]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const wsDone = events.find(
    (e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> =>
      e.type === 'response.output_item.done'
      && (e.item as { type?: string }).type === 'web_search_call',
  );
  assert(wsDone !== undefined);
  const doneItem = wsDone.item as ResponsesOutputWebSearchCall;
  assert(doneItem.action !== undefined);
  assertEquals(doneItem.action.type, 'search');
  assertEquals((doneItem.action as Extract<ResponsesWebSearchAction, { type: 'search' }>).queries, [invalidRef]);
});

test('open with valid URL whose fetch fails: done frame carries action.type="open_page" with the same url', async () => {
  // For a valid URL whose fetch fails, the done frame preserves the
  // url on the open_page action so typed-SDK clients that render
  // `action.url` can still surface the model's intent. The
  // explanatory error snippet lives in results[0].
  const failingUrl = 'https://example.com/missing';
  makeStubDeps({
    providerOverrides: {
      async fetchPage() {
        return {
          type: 'ok',
          pages: [],
          failures: [{ url: failingUrl, errorCode: 'unavailable', message: '404 Not Found' }],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const turn1 = openCallTurn(0, 'call_open', failingUrl);
  const script = scriptedRun([turn1, messageTurn('done', 0)]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const wsDone = events.find(
    (e): e is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> =>
      e.type === 'response.output_item.done'
      && (e.item as { type?: string }).type === 'web_search_call',
  );
  assert(wsDone !== undefined);
  const doneItem = wsDone.item as ResponsesOutputWebSearchCall;
  assertEquals(doneItem.action, { type: 'open_page', url: failingUrl });
  // Error explanation lives on the results snippet, not the action.
  assertEquals(doneItem.results?.length, 1);
  assert(doneItem.results?.[0].snippet.includes('404 Not Found'));
});

test('include: ["web_search_call.action.sources"] populates action.sources with search-result URLs', async () => {
  // Native Responses gates `action.sources` on this exact include
  // token. Clients reading `web_search_call.action.sources` against
  // a native upstream see the URLs of every search hit; the shim
  // mirrors that opt-in shape so a switch from native to shim is
  // observably identical.
  makeStubDeps({
    providerOverrides: {
      async search() {
        return {
          type: 'ok',
          results: [
            { source: 'https://example.com/a', title: 'A', content: [{ type: 'text', text: 'a' }] },
            { source: 'https://example.com/b', title: 'B', content: [{ type: 'text', text: 'b' }] },
          ],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: { include: ['web_search_call.action.sources'] },
  });
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const doneEvents = outputItemDoneEvents(await collectFrames(result.events));
  const wsCallDone = doneEvents.find(e => e.item.type === 'web_search_call');
  assert(wsCallDone !== undefined);
  const item = wsCallDone.item as ResponsesOutputWebSearchCall;
  const action = item.action as { type: 'search'; sources?: { type: 'url'; url: string }[] };
  assertEquals(action.sources, [
    { type: 'url', url: 'https://example.com/a' },
    { type: 'url', url: 'https://example.com/b' },
  ]);
});

test('without include: ["web_search_call.action.sources"], action.sources is absent (opt-in shape matches native)', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const doneEvents = outputItemDoneEvents(await collectFrames(result.events));
  const wsCallDone = doneEvents.find(e => e.item.type === 'web_search_call');
  assert(wsCallDone !== undefined);
  const item = wsCallDone.item as ResponsesOutputWebSearchCall;
  const action = item.action as { type: 'search'; sources?: unknown };
  assertEquals(action.sources, undefined);
});

test('web_search_call results field is populated on the wire when the client opted in via include: ["web_search_call.results"]', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation(); // Default already opts in.
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const doneEvents = outputItemDoneEvents(await collectFrames(result.events));
  const wsCallDone = doneEvents.find(e => e.item.type === 'web_search_call');
  assert(wsCallDone !== undefined);
  const item = wsCallDone.item as ResponsesOutputWebSearchCall;
  assert(Array.isArray(item.results));
  assert(item.results!.length > 0);
});

test('web_search_call results field is omitted from the wire when the client did not include it (matches native default)', async () => {
  // When the client omits `include: ["web_search_call.results"]`, the
  // wire item carries only id/action — same as native. The IR (and
  // therefore the persisted `payload.private`) still holds the full
  // results so a later-turn echo can be hydrated.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { include: [] } });
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const doneEvents = outputItemDoneEvents(await collectFrames(result.events));
  const wsCallDone = doneEvents.find(e => e.item.type === 'web_search_call');
  assert(wsCallDone !== undefined);
  const item = wsCallDone.item as ResponsesOutputWebSearchCall;
  assertEquals(item.results, undefined);
});

// ── Mixed-tool turn (shim call + client tool present) ─────────────────

test('mixed-tool: shim call + client function_call exits to client after one turn, with both sets of items downstream', async () => {
  // GPT-5.x emits both kinds of tool calls in one turn. The shim executes
  // the shim's searches server-side (so the client sees completed
  // web_search_call lifecycles) and lets the client round-trip its own
  // function_call. No internal rerun, no rejection injection.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const wsArgs = JSON.stringify({ search_query: [{ q: 'q1' }] });
  const mixedTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_ws', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, wsArgs),
    mkFunctionCallDone(0, 'call_ws', SHIM_TOOL_NAME, wsArgs),
    mkFunctionCallAdded(1, 'call_other', 'lookup'),
    mkFunctionCallArgsDone(1, '{"q":"x"}', 'fc_1'),
    mkFunctionCallDone(1, 'call_other', 'lookup', '{"q":"x"}'),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([mixedTurn]);

  const originalInputLen = (inv.payload.input as ResponsesInputItem[]).length;
  const { frames } = await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(backend.calls.length, 1);
  assertEquals(script.callCount(), 1);
  assertEquals((inv.payload.input as ResponsesInputItem[]).length, originalInputLen);

  const events = eventPayloads(frames);
  const passThroughAdded = events.find(e =>
    e.type === 'response.output_item.added'
    && (e as { item?: { type?: string; name?: string } }).item?.type === 'function_call'
    && (e as { item?: { name?: string } }).item?.name === 'lookup');
  assert(passThroughAdded !== undefined);
  const wsLifecycleCount = events.filter(e => e.type.startsWith('response.web_search_call')).length;
  assertEquals(wsLifecycleCount, 3);
});

test('mixed-tool: shim call + custom_tool_call exits to client; custom_tool_call frames flush downstream', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const wsArgs = JSON.stringify({ search_query: [{ q: 'q' }] });
  const mixedTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_ws', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, wsArgs),
    mkFunctionCallDone(0, 'call_ws', SHIM_TOOL_NAME, wsArgs),
    mkCustomToolCallAdded(1, 'call_ct', 'my_freeform_tool'),
    mkCustomToolCallInputDone(1, 'raw input'),
    mkCustomToolCallDone(1, 'call_ct', 'my_freeform_tool', 'raw input'),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([mixedTurn]);

  const { frames } = await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(backend.calls.length, 1);
  assertEquals(script.callCount(), 1);

  const events = eventPayloads(frames);
  const customAdded = events.find(e =>
    e.type === 'response.output_item.added'
    && (e as { item?: { type?: string } }).item?.type === 'custom_tool_call');
  assert(customAdded !== undefined);
});

test('client-only tool turn (no shim call): pass-through function_call frames flush downstream and close the loop', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const clientOnlyTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_other', 'lookup'),
    mkFunctionCallArgsDone(0, '{"q":"x"}', 'fc_1'),
    mkFunctionCallDone(0, 'call_other', 'lookup', '{"q":"x"}'),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([clientOnlyTurn]);

  const originalInputLen = (inv.payload.input as ResponsesInputItem[]).length;
  const { frames } = await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);
  // Loop closes after the single turn — the client drives the next round.
  assertEquals(script.callCount(), 1);
  assertEquals(backend.calls.length, 0);
  assertEquals((inv.payload.input as ResponsesInputItem[]).length, originalInputLen);

  const events = eventPayloads(frames);
  const passThroughAdded = events.find(e =>
    e.type === 'response.output_item.added'
    && (e as { item?: { type?: string; name?: string } }).item?.type === 'function_call'
    && (e as { item?: { name?: string } }).item?.name === 'lookup');
  assert(passThroughAdded !== undefined);
});

// ── Pass-through of replayed web_search_call from input ────────────────

// ── Input preprocessor: web_search_call items → shim call pair ─────────

test('input preprocessor: each web_search_call item becomes one shim call + function_call_output pair', async () => {
  // Upstream knows the shim call only as a function tool; a hosted
  // `web_search_call` item type in its input would be unrecognized. We
  // translate each echoed item into a function_call + function_call_output
  // pair that the upstream model can reason over. With no per-item
  // private payload (this test runs raw through the shim), the
  // function_call mirrors the wire action shape and the
  // function_call_output is the placeholder — the shim deliberately
  // ignores the wire `results` field because gateway-side state is the
  // only source of truth.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const replayedSearch: ResponsesInputWebSearchCall = {
    type: 'web_search_call',
    id: 'ws_old_search',
    status: 'completed',
    action: { type: 'search', queries: ['hello world'] },
    results: [{ type: 'text_result', url: 'https://x', title: 'X', snippet: 'snippet body' }],
  };
  const replayedOpen: ResponsesInputWebSearchCall = {
    type: 'web_search_call',
    id: 'ws_old_open',
    status: 'completed',
    action: { type: 'open_page', url: 'https://y' },
    results: [{ type: 'text_result', url: 'https://y', title: 'Y', snippet: 'page body' }],
  };
  const inv = makeInvocation({
    payload: {
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        replayedSearch,
        { type: 'message', role: 'user', content: 'thanks' },
        replayedOpen,
      ],
    },
  });
  const script = scriptedRun([messageTurn('done')]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  // Original 2 messages + 2 expanded pairs (2 items each) = 6 items.
  assertEquals(input.length, 6);
  assertEquals(input.map(i => i.type), [
    'message', 'function_call', 'function_call_output',
    'message', 'function_call', 'function_call_output',
  ]);
  // No web_search_call items remain after preprocessing.
  assertFalse(input.some(i => i.type === 'web_search_call'));
  // The pair from the search reflects its action.
  const searchFc = input[1] as { name: string; arguments: string };
  assertEquals(searchFc.name, SHIM_TOOL_NAME);
  assert(searchFc.arguments.includes('hello world'));
  // No payload → output is the not-preserved placeholder, not the
  // wire snippet. A re-search prompt is emitted when data is needed.
  const searchOut = input[2] as { output: string };
  assert(searchOut.output.includes('not preserved'));
  assertFalse(searchOut.output.includes('snippet body'));
  const openOut = input[5] as { output: string };
  assert(openOut.output.includes('not preserved'));
  assertFalse(openOut.output.includes('page body'));
});

test('input preprocessor: replay-only activation leaves hosted tool_choice unchanged when no hosted tool is declared', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [],
      tool_choice: { type: 'web_search_preview' },
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'web_search_call',
          id: 'ws_old_search',
          status: 'completed',
          action: { type: 'search', queries: ['hello world'] },
          results: [{ type: 'text_result', url: 'https://x', title: 'X', snippet: 'snippet body' }],
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('done')]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(inv.payload.tool_choice, { type: 'web_search_preview' });
  const input = inv.payload.input as ResponsesInputItem[];
  assertEquals(input.map(i => i.type), ['message', 'function_call', 'function_call_output']);
});

test('input preprocessor: web_search_call without an action is replaced by a placeholder pair (preserves history length)', async () => {
  // A client echo without `action` is malformed — but dropping the
  // item entirely silently shortens conversation history, which can
  // mislead the model (e.g. its reasoning about "your last 3 tool
  // calls" no longer matches reality). Replace with a placeholder
  // shim call (empty args, no logical ops) + a
  // function_call_output telling the model the prior contents
  // weren't preserved. Same idea as the no-payload-with-action path
  // for partial echoes.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'web_search_call',
          id: 'ws_no_action',
          status: 'completed',
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('done')]);
  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  // user message + placeholder function_call + placeholder function_call_output.
  assertEquals(input.length, 3);
  assertEquals(input[0].type, 'message');
  assertEquals(input[1].type, 'function_call');
  assertEquals(input[2].type, 'function_call_output');
  const fc = input[1] as { type: 'function_call'; name: string; arguments: string };
  assertEquals(fc.name, SHIM_TOOL_NAME);
  // Empty args → upstream model sees no logical operations,
  // matching the intent of "we don't know what this call did".
  assertEquals(fc.arguments, '{}');
  const fco = input[2] as { type: 'function_call_output'; output: string };
  assert(fco.output.includes('malformed'));
  // The placeholder includes the JSON.stringify of the original
  // wire item so the model can see what was actually there.
  assert(fco.output.includes('Original wire item:'));
  assert(fco.output.includes('"id":"ws_no_action"'));
});

test('input preprocessor: web_search_call with empty id has its id synthesized and produces an upstream pair (codex CLI strips ws_gw_ ids on session persist)', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        {
          type: 'web_search_call',
          id: '',
          status: 'completed',
          action: { type: 'search', queries: ['q'] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('done')]);
  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  // user message + function_call + function_call_output (paired from the
  // echoed web_search_call with synthesized id).
  assertEquals(input.length, 3);
  assertEquals(input[1].type, 'function_call');
  assertEquals(input[2].type, 'function_call_output');
});

test('input preprocessor: web_search_call without results emits the not-preserved placeholder function_call_output (not a "(no results)" zero-hit message)', async () => {
  // Clients like codex CLI 0.133 drop the results field when persisting
  // sessions. We emit an explicit "not preserved" notice instead of
  // synthesizing a phantom zero-hit response that would mislead the
  // model into thinking the prior search returned nothing.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      input: [
        {
          type: 'web_search_call',
          id: 'ws_no_results',
          status: 'completed',
          action: { type: 'search', queries: ['probe'] },
        },
      ],
    },
  });
  const script = scriptedRun([messageTurn('done')]);
  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const input = inv.payload.input as ResponsesInputItem[];
  assertEquals(input.length, 2);
  const fco = input[1] as { output: string };
  assertEquals(fco.output, 'Prior search results were not preserved in the conversation history. Call web_search again if you need them.');
});

// ── Shim tool name resolution / collision fallback ────────────────

test('client declaring web_search + hosted web_search: shim falls back to web_search_2', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        { type: 'web_search' },
        { type: 'function', name: 'web_search', parameters: { type: 'object' }, strict: false },
      ],
    },
  });
  const fallbackArgs = JSON.stringify({ search_query: [{ q: 'q1' }] });
  const script = scriptedRun([
    fcTurn(0, 'call_1', 'web_search_2', fallbackArgs),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const names = new Set((inv.payload.tools ?? []).map(t => (t as { name: string }).name));
  assertEquals(names, new Set(['web_search_2', 'web_search']));
});

test('client declaring web_search AND web_search_2 + hosted web_search: shim falls back to web_search_3', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        { type: 'web_search' },
        { type: 'function', name: 'web_search', parameters: { type: 'object' }, strict: false },
        { type: 'function', name: 'web_search_2', parameters: { type: 'object' }, strict: false },
      ],
    },
  });
  const args = JSON.stringify({ search_query: [{ q: 'q1' }] });
  const script = scriptedRun([
    fcTurn(0, 'call_1', 'web_search_3', args),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const names = new Set((inv.payload.tools ?? []).map(t => (t as { name: string }).name));
  assertEquals(names, new Set(['web_search', 'web_search_2', 'web_search_3']));
});

// ── 0-event safety bail ───────────────────────────────────────────────

test('upstream returning no actionable events closes the response cleanly', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  // Turn with only response.created / in_progress / completed.
  const emptyTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([emptyTurn]);

  const result = await shim(inv, makeGatewayCtx(), script.run);

  assertEquals(script.callCount(), 1);
  assertEquals(backend.calls.length, 0);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  assertEquals(events[events.length - 1].type, 'response.completed');
});

// ── Provider-config error paths ───────────────────────────────────────────

test('disabled search provider: dispatched op surfaces explanation snippet (no 500 internal-error)', async () => {
  makeStubDeps({
    configured: { type: 'disabled' },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([searchCallTurn(0, 'call_1', 'q'), messageTurn('done', 0)]);

  const { result, frames } = await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(result.type, 'events');
  // Two upstream turns still ran — replay-only / mid-conversation
  // flows must continue to talk to upstream even when search is
  // unconfigured.
  assertEquals(script.callCount(), 2);
  const done = outputItemDoneEvents(frames)
    .map(e => e.item)
    .filter((i): i is ResponsesOutputWebSearchCall => i.type === 'web_search_call');
  assertEquals(done.length, 1);
  const snippet = done[0].results![0].snippet;
  assert(snippet.includes('not configured'));
});

test('missing-credential search provider: dispatched op surfaces explanation snippet naming the provider (no 500 internal-error)', async () => {
  makeStubDeps({
    configured: { type: 'missing-credential', provider: 'tavily' },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([searchCallTurn(0, 'call_1', 'q'), messageTurn('done', 0)]);

  const { result, frames } = await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  assertEquals(result.type, 'events');
  assertEquals(script.callCount(), 2);
  const done = outputItemDoneEvents(frames)
    .map(e => e.item)
    .filter((i): i is ResponsesOutputWebSearchCall => i.type === 'web_search_call');
  assertEquals(done.length, 1);
  const snippet = done[0].results![0].snippet;
  assert(snippet.includes('tavily'));
});

// ── Streaming-specific behavior ───────────────────────────────────────────

test('shim yields first turn frames BEFORE later turns resolve', async () => {
  // Turn 2's run() never resolves until the test releases its gate. Turn
  // 1's frames must be drainable from the iterator before that resolves;
  // otherwise the iterator would block on the gate.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let releaseTurn2: (() => void) | undefined;
  const turn2Gate = new Promise<void>(resolve => {
    releaseTurn2 = resolve;
  });

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of searchCallTurn(0, 'call_1', 'q1')) yield f;
      })();
      return {
        type: 'events',
        events: frames,
        modelIdentity: testTelemetryModelIdentity,
      };
    }
    if (runCalls === 2) {
      await turn2Gate;
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of messageTurn('summary', 0)) yield f;
      })();
      return {
        type: 'events',
        events: frames,
        modelIdentity: testTelemetryModelIdentity,
      };
    }
    throw new Error(`unexpected run() call ${runCalls}`);
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const iter = result.events[Symbol.asyncIterator]();

  // Pull until response.output_item.done for the web_search_call — proves
  // turn 1 + synthesized web_search_call frames reach the client BEFORE
  // run() #2 has been invoked. Bounded upper limit so the test fails
  // loudly if buffering reappears.
  const seenTypes: string[] = [];
  let sawWebSearchCallDone = false;
  for (let i = 0; i < 16; i++) {
    const next = await iter.next();
    if (next.done) break;
    if (next.value.type === 'event') {
      seenTypes.push(next.value.event.type);
      if (
        next.value.event.type === 'response.output_item.done'
        && (next.value.event as { item?: { type?: string } }).item?.type === 'web_search_call'
      ) {
        sawWebSearchCallDone = true;
        break;
      }
    }
  }

  assert(sawWebSearchCallDone, `expected to see web_search_call output_item.done before turn 2; saw: ${seenTypes.join(', ')}`);
  // Turn-1 frames yielded without advancing into turn 2's run().
  assertEquals(runCalls, 1);
  releaseTurn2!();
  while (!(await iter.next()).done) { /* drain */ }
  assertEquals(runCalls, 2);
});

test('turn 1 pure-text response streams BEFORE upstream terminal (no TTFT regression)', async () => {
  // A turn-1 pure-text response (no tool call) must not block downstream
  // until `response.completed` arrives — that would regress TTFT on
  // every shim-routed request. The preflight stops the moment
  // `response.created` is captured; everything else (output_text deltas,
  // terminal) streams live through the same iterator.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  // Gate the upstream terminal frame so a buffered implementation would
  // be stuck waiting on it before yielding any byte downstream.
  let releaseTerminal: (() => void) | undefined;
  const terminalGate = new Promise<void>(resolve => {
    releaseTerminal = resolve;
  });
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
      yield mkResponseCreated();
      yield mkResponseInProgress();
      yield mkMessageAdded(0);
      yield eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        delta: 'hello',
      });
      await terminalGate;
      yield mkMessageDone(0, 'hello');
      yield mkResponseCompleted();
    })();
    return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const iter = result.events[Symbol.asyncIterator]();

  // Drain until the first output_text.delta arrives, asserting it lands
  // BEFORE the gated terminal. Bounded loop catches buffering regressions
  // by failing loudly when no delta surfaces in the live window.
  let sawDelta = false;
  for (let i = 0; i < 16; i++) {
    const next = await iter.next();
    if (next.done) break;
    if (next.value.type === 'event' && next.value.event.type === 'response.output_text.delta') {
      sawDelta = true;
      break;
    }
  }
  assert(sawDelta, 'expected the first output_text.delta to arrive BEFORE the upstream terminal frame');
  releaseTerminal!();
  while (!(await iter.next()).done) { /* drain */ }
});

test('mid-stream upstream error yields response.failed and closes the SSE stream', async () => {
  // After turn 1 emits a web_search call, turn 2's run() returns an
  // upstream-error envelope. The shim must yield a single terminal
  // response.failed frame and end the iterator — switching the outer
  // envelope to upstream-error is impossible: the outer envelope shape
  // is locked once the first frame is yielded.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of searchCallTurn(0, 'call_1', 'q1')) yield f;
      })();
      return {
        type: 'events',
        events: frames,
        modelIdentity: testTelemetryModelIdentity,
      };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 503,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode('{"error":"upstream temporarily unavailable"}'),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  const terminal = events[events.length - 1];
  assertEquals(terminal.type, 'response.failed');
  const failedEv = terminal as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failedEv.response.status, 'failed');
  assert(failedEv.response.error !== undefined);
  // Pass-through code: the shim quotes upstream's HTTP status
  // (`upstream_<status>`) when the body has no OpenAI-shaped error
  // envelope. No normalization to a spec enum value.
  assertEquals(failedEv.response.error?.code, 'upstream_503');
  assert(failedEv.response.error?.message.includes('503'));
  assertFalse(events.some(e => e.type === 'response.completed'));
  assertEquals(runCalls, 2);
});

test('mid-stream 429 pass-through: code reflects upstream HTTP status (no spec-enum normalization)', async () => {
  // The shim no longer normalizes upstream error codes to the
  // OpenAPI `ResponsesErrorCode` enum. A 429 with no OpenAI-shaped
  // body falls back to `upstream_429` — the HTTP status is the most
  // honest signal, and downstream clients pattern-matching on
  // upstream's actual code see it directly.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of searchCallTurn(0, 'call_1', 'q1')) yield f;
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 429,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new TextEncoder().encode('rate limited'),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const failed = events[events.length - 1] as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failed.response.error?.code, 'upstream_429');
});

test('mid-stream 400 with non-OpenAI body falls back to upstream_400 code (no spec-enum normalization)', async () => {
  // Without an OpenAI-shaped `error.code` in the body, the shim
  // synthesizes `upstream_<status>` rather than mapping to a spec
  // enum value. The body excerpt and status live in `error.message`
  // so clients still see the upstream detail.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of searchCallTurn(0, 'call_1', 'q1')) yield f;
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 400,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: new TextEncoder().encode('bad request'),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const failed = events[events.length - 1] as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failed.response.error?.code, 'upstream_400');
  // The HTTP status is preserved in the diagnostic message so clients
  // pattern-matching for 4xx see it.
  assert(failed.response.error?.message.includes('400'));
  assert(failed.response.error?.message.includes('bad request'));
  assertFalse('type' in (failed.response.error as object));
});

test('mid-stream upstream error with OpenAI-shaped JSON body forwards code/type/message verbatim', async () => {
  // When upstream is OpenAI-compatible and gives us a standard error
  // envelope, pass it through unchanged so SDKs see the same vocabulary
  // they'd see hitting upstream directly.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of searchCallTurn(0, 'call_1', 'q1')) yield f;
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 429,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify({
        error: {
          message: 'You exceeded your current quota.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
          param: null,
        },
      })),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const failed = events[events.length - 1] as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(failed.response.error?.code, 'insufficient_quota');
  assertEquals(failed.response.error?.type, 'insufficient_quota');
  assertEquals(failed.response.error?.message, 'You exceeded your current quota.');
});

test('upstream response.incomplete forwards as response.incomplete with the same incomplete_details.reason', async () => {
  // Native upstreams emit response.incomplete when the model stopped
  // before producing a terminal message (max_output_tokens,
  // content_filter, ...). The shim used to rewrite it as
  // response.completed, silently destroying the reason field that
  // clients branch on. Forward the frame as-is with upstream's reason
  // preserved.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  const incompleteTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'partial answer'),
    mkResponseIncomplete({ reason: 'max_output_tokens' }),
  ];
  const script = scriptedRun([incompleteTurn]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  const terminal = events[events.length - 1] as Extract<ResponsesStreamEvent, { type: 'response.incomplete' }>;
  assertEquals(terminal.type, 'response.incomplete');
  assertEquals(terminal.response.status, 'incomplete');
  assertEquals(terminal.response.incomplete_details, { reason: 'max_output_tokens' });
  assertEquals(terminal.response.output.map(item => item.type), ['message']);
  assertEquals(terminal.response.output_text, 'partial answer');
  assertFalse(events.some(e => e.type === 'response.completed'));
});

test('upstream response.incomplete WITHOUT incomplete_details forwards as response.incomplete with whatever upstream emitted (no synthetic fold to response.failed)', async () => {
  // Pass-through contract for `response.incomplete`: the shim
  // forwards upstream's emission verbatim. If upstream sent
  // `incomplete_details: null`, the downstream wire keeps null;
  // synthesizing a different terminal kind would lie about what
  // upstream said.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  const incompleteTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'partial answer'),
    mkResponseIncomplete(undefined),
  ];
  const script = scriptedRun([incompleteTurn]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  const terminal = events[events.length - 1];
  assertEquals(terminal.type, 'response.incomplete');
  const incomplete = terminal as Extract<ResponsesStreamEvent, { type: 'response.incomplete' }>;
  assertEquals(incomplete.response.incomplete_details, null);
  assertEquals(incomplete.response.output.map(item => item.type), ['message']);
});

test('upstream response.incomplete after a server tool call keeps synthesized tool output in the terminal response', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const argsJson = JSON.stringify({ search_query: [{ q: 'q1' }] });
  const incompleteTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'partial answer'),
    mkFunctionCallAdded(1, 'call_ws', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(1, argsJson),
    mkFunctionCallDone(1, 'call_ws', SHIM_TOOL_NAME, argsJson),
    mkResponseIncomplete({ reason: 'max_output_tokens' }),
  ];
  const script = scriptedRun([incompleteTurn]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const terminal = events.at(-1) as Extract<ResponsesStreamEvent, { type: 'response.incomplete' }>;

  assertEquals(terminal.type, 'response.incomplete');
  assertEquals(terminal.response.output.map(item => item.type), ['message', 'web_search_call']);
  assertEquals(terminal.response.output_text, 'partial answer');
  assertEquals(terminal.response.incomplete_details, { reason: 'max_output_tokens' });
});

// ── function_call_output is plain text on every target ───────────────

const lastFunctionCallOutput = (input: ResponsesInputItem[]): string => {
  const last = input[input.length - 1];
  assert(last.type === 'function_call_output');
  return (last as { output: string }).output;
};

test('responses target with flag on: function_call_output is plain-text formatted search results', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    targetApi: 'responses',
    enabledFlags: new Set<string>(['responses-web-search-shim']),
  });
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const text = lastFunctionCallOutput(inv.payload.input as ResponsesInputItem[]);
  assert(text.startsWith('Search results for "q1":'));
});

test('chat-completions target: function_call_output is plain-text formatted search results', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ targetApi: 'chat-completions' });
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const text = lastFunctionCallOutput(inv.payload.input as ResponsesInputItem[]);
  assert(text.startsWith('Search results for "q1":'));
});

test('messages target: function_call_output is plain-text formatted search results', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ targetApi: 'messages' });
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const text = lastFunctionCallOutput(inv.payload.input as ResponsesInputItem[]);
  assert(text.startsWith('Search results for "q1":'));
});

// ── Forced tool_choice demotes after turn 1 ───────────────────────────

test('tool_choice "required" demotes to "auto" after first intercepted turn', async () => {
  // Without demote: the model is required to call a tool every turn,
  // never produces a terminal message, loops until the iteration cap.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { tool_choice: 'required' } });
  // Capture tool_choice on each run() call so we can verify the payload
  // mutation before draining events.
  const seenToolChoices: unknown[] = [];
  const baseScript = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);
  const wrappedRun = async () => {
    seenToolChoices.push(inv.payload.tool_choice);
    return await baseScript.run();
  };

  await runShimAndDrain(shim, inv, makeGatewayCtx(), wrappedRun);

  assertEquals(seenToolChoices[0], 'required');
  assertEquals(seenToolChoices[1], 'auto');
});

test('tool_choice {type:"function", name:<shim tool name>} demotes to "auto" after first intercepted turn', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: { tool_choice: { type: 'function', name: SHIM_TOOL_NAME } },
  });
  const seenToolChoices: unknown[] = [];
  const baseScript = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);
  const wrappedRun = async () => {
    seenToolChoices.push(inv.payload.tool_choice);
    return await baseScript.run();
  };

  await runShimAndDrain(shim, inv, makeGatewayCtx(), wrappedRun);

  assertEquals(seenToolChoices[0], { type: 'function', name: SHIM_TOOL_NAME });
  assertEquals(seenToolChoices[1], 'auto');
});

test('hosted {type:"web_search_preview"} tool_choice gets rewritten and then demoted', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tool_choice: { type: 'web_search_preview' },
    },
  });
  const seenToolChoices: unknown[] = [];
  const baseScript = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);
  const wrappedRun = async () => {
    seenToolChoices.push(inv.payload.tool_choice);
    return await baseScript.run();
  };

  await runShimAndDrain(shim, inv, makeGatewayCtx(), wrappedRun);

  assertEquals(seenToolChoices[0], { type: 'function', name: SHIM_TOOL_NAME });
  assertEquals(seenToolChoices[1], 'auto');
});

test('tool_choice "auto" stays "auto" — no demotion when never forced', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { tool_choice: 'auto' } });
  const seenToolChoices: unknown[] = [];
  const baseScript = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    messageTurn('done', 0),
  ]);
  const wrappedRun = async () => {
    seenToolChoices.push(inv.payload.tool_choice);
    return await baseScript.run();
  };

  await runShimAndDrain(shim, inv, makeGatewayCtx(), wrappedRun);

  assertEquals(seenToolChoices[0], 'auto');
  assertEquals(seenToolChoices[1], 'auto');
});

test('cap-exceeded does NOT set tool_choice="none" — the cap snippet alone nudges the model toward other tools', async () => {
  // `'none'` blocks every tool the model can call — including client tools
  // the model needs to make progress on the user's task. The cap intent is
  // "stop calling web_search", which `'none'` does not express. The cap
  // path relies solely on the exhausted-budget snippet to nudge the model
  // to switch tools or settle on a terminal message.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { tool_choice: 'auto' } });
  // 30 search turns, then turn 31 (cap-exceeded), then a final message.
  const searchTurns: ScriptedTurn[] = [];
  for (let i = 0; i < 31; i++) {
    searchTurns.push(searchCallTurn(0, `call_${i}`, `q${i}`));
  }
  searchTurns.push(messageTurn('done', 0));
  const seenToolChoices: unknown[] = [];
  const baseScript = scriptedRun(searchTurns);
  const wrappedRun = async () => {
    seenToolChoices.push(inv.payload.tool_choice);
    return await baseScript.run();
  };

  await runShimAndDrain(shim, inv, makeGatewayCtx(), wrappedRun);

  // Every turn observed `'auto'` — no demotion to 'none' after the cap.
  assertEquals(seenToolChoices[30], 'auto');
  assertEquals(seenToolChoices[31], 'auto');
});

test('max_tool_calls is forwarded to upstream turns but does not locally bypass server tools', async () => {
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { max_tool_calls: 1 } });
  const seenMaxToolCalls: unknown[] = [];
  const baseScript = scriptedRun([
    searchCallTurn(0, 'call_1', 'q1'),
    searchCallTurn(0, 'call_2', 'q2'),
    messageTurn('done', 0),
  ]);
  const run = async () => {
    seenMaxToolCalls.push(inv.payload.max_tool_calls);
    return await baseScript.run();
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  await collectFrames(result.events);
  assertEquals(seenMaxToolCalls, [1, 0, 0]);
  assertEquals(backend.calls.filter(c => c.kind === 'search').length, 2);
});

test('max_tool_calls invalid values pass through to upstream and do not engage local accounting', async () => {
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { max_tool_calls: 'one' as unknown as number } });
  const script = scriptedRun([messageTurn('hello', 0)]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  assertEquals(events[events.length - 1].type, 'response.completed');
});

// ── Live forwarding of message-owned events ──────────────────────────────

test('final-turn text deltas stream as they arrive, not buffered until response.completed', async () => {
  // Two-turn script: turn 1 forces a backend call + second run(); turn 2
  // emits two output_text.delta events separated by a gate. Asserting the
  // first delta is drainable while the gate is still closed proves true
  // byte-by-byte streaming.
  makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  let releaseRestOfTurn2: (() => void) | undefined;
  const restOfTurn2Gate = new Promise<void>(resolve => {
    releaseRestOfTurn2 = resolve;
  });

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        for (const f of searchCallTurn(0, 'call_1', 'q1')) yield f;
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    if (runCalls === 2) {
      // Emit message.added + first delta immediately, gate the rest. A
      // buffered implementation would hide the first delta until
      // response.completed.
      const frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
        yield mkResponseCreated();
        yield mkResponseInProgress();
        yield mkMessageAdded(0);
        yield eventFrame<ResponsesStreamEvent>({
          type: 'response.output_text.delta',
          item_id: 'msg_upstream',
          output_index: 0,
          content_index: 0,
          delta: 'first',
        });
        await restOfTurn2Gate;
        yield eventFrame<ResponsesStreamEvent>({
          type: 'response.output_text.delta',
          item_id: 'msg_upstream',
          output_index: 0,
          content_index: 0,
          delta: ' second',
        });
        yield mkMessageDone(0, 'first second');
        yield mkResponseCompleted();
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    throw new Error(`unexpected run() call ${runCalls}`);
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const iter = result.events[Symbol.asyncIterator]();

  // Drain until the first output_text.delta with the gate still closed.
  let sawFirstDelta = false;
  for (let i = 0; i < 64; i++) {
    const next = await iter.next();
    if (next.done) break;
    if (next.value.type === 'event' && next.value.event.type === 'response.output_text.delta') {
      const deltaEv = next.value.event as Extract<ResponsesStreamEvent, { type: 'response.output_text.delta' }>;
      assertEquals(deltaEv.delta, 'first');
      sawFirstDelta = true;
      break;
    }
  }
  assert(sawFirstDelta, 'expected the first output_text.delta to be drainable BEFORE response.completed');

  releaseRestOfTurn2!();
  while (!(await iter.next()).done) { /* drain */ }
});

test('mixed turn (reasoning + message_partial + function_call) preserves the message and emits web_search_call', async () => {
  // Turn shape mirrors a mid-stream "thinking out loud" pattern:
  // [reasoning, message, function_call]. The message forwards live and
  // the synthesized web_search_call follows it.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  const mixedTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkReasoningAdded(0, 'rs_1'),
    mkReasoningDone(0, 'rs_1'),
    mkMessageAdded(1),
    eventFrame<ResponsesStreamEvent>({
      type: 'response.output_text.delta',
      item_id: 'msg_upstream',
      output_index: 1,
      content_index: 0,
      delta: 'thinking out loud',
    }),
    mkMessageDone(1, 'thinking out loud'),
    mkFunctionCallAdded(2, 'call_ws', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(2, JSON.stringify({ search_query: [{ q: 'q1' }] })),
    mkFunctionCallDone(2, 'call_ws', SHIM_TOOL_NAME, JSON.stringify({ search_query: [{ q: 'q1' }] })),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([mixedTurn, messageTurn('final answer', 0)]);
  const observedInputs: ResponsesPayload['input'][] = [];
  const run = async () => {
    observedInputs.push(inv.payload.input);
    return await script.run();
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  assertEquals(backend.calls.length, 1);

  const messageDones = events.filter(e =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'message');
  // The partial intermediate message from turn 1 + the final message from turn 2.
  assertEquals(messageDones.length, 2);
  const wsCallLifecycle = events.filter(e => e.type.startsWith('response.web_search_call'));
  assertEquals(wsCallLifecycle.length, 3);
  assert(events.some(e => e.type === 'response.output_text.delta'));
  const turn2Input = observedInputs[1];
  assert(Array.isArray(turn2Input));
  assert(turn2Input.some(item =>
    item.type === 'message'
    && item.role === 'assistant'
    && Array.isArray(item.content)
    && item.content.some(block => block.type === 'output_text' && block.text === 'thinking out loud')));
});

test('two consecutive tool-call turns each with a thinking-out-loud message preserve both messages downstream', async () => {
  // Mixed turns are common: a model emits a brief intermediate text block
  // before dispatching its tool call. Both intermediate messages forward
  // live and survive in the downstream output.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();

  const thinkingTurn = (
    msgUpstreamIdx: number,
    msgText: string,
    fcUpstreamIdx: number,
    callId: string,
    query: string,
  ): ScriptedTurn => {
    const args = JSON.stringify({ search_query: [{ q: query }] });
    return [
      mkResponseCreated(),
      mkResponseInProgress(),
      mkMessageAdded(msgUpstreamIdx),
      mkMessageDone(msgUpstreamIdx, msgText),
      mkFunctionCallAdded(fcUpstreamIdx, callId, SHIM_TOOL_NAME),
      mkFunctionCallArgsDone(fcUpstreamIdx, args),
      mkFunctionCallDone(fcUpstreamIdx, callId, SHIM_TOOL_NAME, args),
      mkResponseCompleted(),
    ];
  };

  const script = scriptedRun([
    thinkingTurn(0, 'first thought', 1, 'call_1', 'q1'),
    thinkingTurn(0, 'second thought', 1, 'call_2', 'q2'),
    messageTurn('final answer', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));

  assertEquals(backend.calls.length, 2);

  // Three messages: two intermediate + the final.
  const messageDones = events.filter(e =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'message');
  assertEquals(messageDones.length, 3);
  const messageTexts = messageDones.map(e => {
    const item = (e as { item: { content: Array<{ text: string }> } }).item;
    return item.content[0].text;
  });
  assert(messageTexts.includes('first thought'));
  assert(messageTexts.includes('second thought'));
  assert(messageTexts.includes('final answer'));

  const wsCallAdded = events.filter(e =>
    e.type === 'response.output_item.added'
    && (e as { item?: { type?: string } }).item?.type === 'web_search_call');
  assertEquals(wsCallAdded.length, 2);
});

test('lifecycle start frames yield BEFORE backend resolves, giving searching real wall-clock duration', async () => {
  // Gate provider.search() so the test can observe ordering: lifecycle
  // start frames must be drainable WHILE the backend is pending. If the
  // shim awaits the backend before yielding start frames, next() after
  // response.created will hang on the gate.
  let releaseSearch: (() => void) | null = null;
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve; });
  const { backend } = makeStubDeps({
    providerOverrides: {
      async search(_req) {
        await searchGate;
        return {
          type: 'ok',
          results: [{
            source: 'https://example.com/a',
            title: 'A',
            content: [{ type: 'text', text: 'snippet' }],
          }],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'gated-q'),
    messageTurn('done', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const iter = result.events[Symbol.asyncIterator]();

  // Pull until web_search_call.searching arrives. With the gate closed,
  // searching must arrive but completed / done must NOT.
  let sawSearching = false;
  let sawCompleted = false;
  const drainedSoFar: ResponsesStreamEvent[] = [];
  for (let i = 0; i < 64 && !sawSearching; i++) {
    const next = await iter.next();
    if (next.done) break;
    const f = next.value;
    if (f.type !== 'event') continue;
    drainedSoFar.push(f.event);
    if (f.event.type === 'response.web_search_call.searching') sawSearching = true;
    if (f.event.type === 'response.web_search_call.completed') sawCompleted = true;
  }
  assertEquals(sawSearching, true);
  // Critical: searching arrived but completed did NOT — the shim hasn't
  // awaited the backend yet, but the wire already shows searching.
  assertEquals(sawCompleted, false);
  // The backend call IS in flight (awaiting the gate); the call was placed
  // but has no result yet.
  assertEquals(backend.calls.filter(c => c.kind === 'search').length, 1);

  releaseSearch!();
  while (true) {
    const next = await iter.next();
    if (next.done) break;
    const f = next.value;
    if (f.type === 'event') drainedSoFar.push(f.event);
  }
  const types = drainedSoFar.map(e => e.type);
  assert(types.includes('response.web_search_call.completed'));
  assert(types.includes('response.output_item.done'));
});

test('terminal response.completed.output is in output_index order, not completion order (shim backend resolves AFTER a later live item)', async () => {
  // The shim call reserves downstream index 0 at output_item.added time;
  // the mixed-tool client function_call gets downstream index 1.
  // We gate the backend so the shim's output_item.done fires AFTER
  // the client function_call has already finalized into accumulatedOutput.
  // The sparse-index materialization at terminal time must still place
  // the shim call at output[0] and the client tool at output[1].
  let releaseSearch: (() => void) | null = null;
  const searchGate = new Promise<void>(resolve => { releaseSearch = resolve; });
  makeStubDeps({
    providerOverrides: {
      async search(_req) {
        await searchGate;
        return {
          type: 'ok',
          results: [{
            source: 'https://example.com/a',
            title: 'A',
            content: [{ type: 'text', text: 'snippet' }],
          }],
        };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const wsArgs = JSON.stringify({ search_query: [{ q: 'q' }] });
  // Shim call at upstream index 0, client tool at upstream index 1. The
  // upstream's response.completed arrives BEFORE the gated backend
  // resolves; the shim will release end frames lazily as the consumer
  // pulls (so we must release the gate to finish the stream).
  const mixedTurn: ScriptedTurn = [
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_ws', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, wsArgs),
    mkFunctionCallDone(0, 'call_ws', SHIM_TOOL_NAME, wsArgs),
    mkFunctionCallAdded(1, 'call_other', 'lookup'),
    mkFunctionCallArgsDone(1, '{"q":"x"}', 'fc_1'),
    mkFunctionCallDone(1, 'call_other', 'lookup', '{"q":"x"}'),
    mkResponseCompleted(),
  ];
  const script = scriptedRun([mixedTurn]);
  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  // Release the gate so the shim call end frames + terminal can resolve.
  releaseSearch!();
  const events = eventPayloads(await collectFrames(result.events));
  const terminal = events[events.length - 1];
  assertEquals(terminal.type, 'response.completed');
  const output = (terminal as { response: { output: Array<{ type: string }> } }).response.output;
  // Two items: shim web_search_call at slot 0, client function_call at slot 1.
  // Reserved-slot ordering wins even though the client tool finalized
  // first (no await on the .done path) and the shim call finalized last.
  assertEquals(output.map(o => o.type), ['web_search_call', 'function_call']);
});

// ── End-to-end protocol-violation paths ──────────────────────────────

test('shim call without output_item.done synthesizes response.failed (no backend dispatch)', async () => {
  // Protocol violation: upstream emits the shim's added +
  // arguments deltas but no `.done`. The unmatched-shim-call detector
  // in consume-turn must promote the turn to `response.failed`; no
  // backend search / fetchPage should fire (the shim call never
  // dispatched).
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const argsJson = JSON.stringify({ search_query: [{ q: 'truncated' }] });
  const script = scriptedRun([[
    mkResponseCreated(),
    mkResponseInProgress(),
    mkFunctionCallAdded(0, 'call_truncated', SHIM_TOOL_NAME),
    mkFunctionCallArgsDone(0, argsJson),
    // No `mkFunctionCallDone` — upstream protocol violation.
    mkResponseCompleted(),
  ]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const terminal = events[events.length - 1] as Extract<ResponsesStreamEvent, { type: 'response.failed' }>;
  assertEquals(terminal.type, 'response.failed');
  assertEquals(terminal.response.error?.code, 'server_error');
  assert(terminal.response.error?.message.includes('without closing shim call items'));
  // Backend never invoked — dispatch only fires from output_item.done.
  assertEquals(backend.calls.length, 0);
});

test('wrong-typed supported sub-property (search_query as object) synthesizes a search-type schema-error item without backend dispatch', async () => {
  // `search_query` is documented as an array; sending it as an
  // object is a sub-property type violation. Dispatch must route
  // through the schema-error IR (action.type:'search' carrier with
  // a "wrong-type sub-property" snippet) instead of crashing the
  // dispatcher. Backend search should NOT fire.
  const { backend } = makeStubDeps();
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  // Pass `search_query` as a single object — wrong type.
  const wrongArgs = JSON.stringify({ search_query: { q: 'x' } });
  const script = scriptedRun([
    fcTurn(0, 'call_wrong', SHIM_TOOL_NAME, wrongArgs),
    messageTurn('giving up', 0),
  ]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const frames = await collectFrames(result.events);
  const doneEvents = outputItemDoneEvents(frames);
  const wsCallDone = doneEvents.find(e => e.item.type === 'web_search_call');
  assert(wsCallDone !== undefined);
  const item = wsCallDone.item as ResponsesOutputWebSearchCall;
  // Schema-error IR rides action.type:'search' as the neutral carrier
  // and surfaces the violation in the results snippet.
  assertEquals(item.action?.type, 'search');
  assert(item.results !== undefined);
  assert(item.results.length > 0);
  assert(item.results[0].snippet.includes('search_query'));
  // No backend search fired — schema errors short-circuit before dispatch.
  assertEquals(backend.calls.length, 0);
});

test('downstream AbortSignal threads through to provider search / fetchPage and propagates aborts', async () => {
  // Cancelled requests must stop generating upstream load. The shim
  // threads the request's `downstreamAbortSignal` into every backend
  // provider call so providers can observe and abort.
  let observedSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const { backend } = makeStubDeps({
    providerOverrides: {
      // Capture the signal the shim hands us; resolve only when the
      // signal aborts so we can assert downstream propagation.
      async search(request) {
        observedSignal = request.signal;
        await new Promise<void>((resolve, reject) => {
          if (request.signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          request.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
        // Unreachable — the await above either rejects or hangs.
        return { type: 'ok', results: [] };
      },
    },
  });
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation();
  const gatewayCtx: ChatGatewayCtx = {
    apiKeyId: 'k1',
    upstreamIds: null,
    wantsStream: true,
    runtimeLocation: 'TEST',
    currentColo: 'TEST',
    dump: null,
    backgroundScheduler: () => {},
    requestStartedAt: 0,
    store: createNonResponsesSourceStore('k1'),
    abortSignal: controller.signal,
  };
  const script = scriptedRun([
    searchCallTurn(0, 'call_1', 'will-be-aborted'),
  ]);

  const result = await shim(inv, gatewayCtx, script.run);
  assert(result.type === 'events');
  // Drain the events stream in the background. The backend search
  // will hang until we abort, so the drain promise won't resolve
  // until the abort surfaces as a thrown rejection in the loop.
  const drainPromise = collectFrames(result.events).catch(() => []);

  // Wait a microtask for the search() to be invoked and capture the signal.
  while (observedSignal === undefined) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  // Same instance identity — not a clone.
  assertEquals(observedSignal, controller.signal);
  assertFalse(observedSignal.aborted);

  // Abort and let the drain complete (the rejected backend promise
  // will surface as a mid-stream synthesized response.failed).
  controller.abort();
  await drainPromise;
  // Only the one search was attempted; no follow-up turn fired.
  assertEquals(backend.calls.length, 1);
});

// ── consumeTurnStreaming: single-turn stream consumption mechanics ──

const mkFunctionCallArgsDelta = (outputIndex: number, delta: string, itemId = `fc_${outputIndex}`): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });

const mkCustomToolCallInputDelta = (outputIndex: number, delta: string, itemId = `cti_${outputIndex}`): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.custom_tool_call_input.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });

const framesOf = (...frames: ProtocolFrame<ResponsesStreamEvent>[]): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> => (async function* () {
  yield* frames;
})();

const eventTypesOf = (frames: ProtocolFrame<ResponsesStreamEvent>[]): string[] =>
  frames.flatMap(f => (f.type === 'event' ? [f.event.type] : []));

interface DispatchRecord {
  intercepted: InterceptedFunctionCall;
}

// Records every shim call without producing IRs or start frames.
// Tests that care about dispatcher behavior pass a custom dispatcher.
const recordingDispatcher = (records: DispatchRecord[]) => ({ intercepted }: { intercepted: InterceptedFunctionCall }) => {
  records.push({ intercepted });
  return [] as ServerToolResultSlot[];
};

type DrainResult = {
  downstreamFrames: ProtocolFrame<ResponsesStreamEvent>[];
  summary: TurnSummary;
  records: DispatchRecord[];
};

const drain = async (
  iter: AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary>,
  records: DispatchRecord[],
): Promise<DrainResult> => {
  const downstreamFrames: ProtocolFrame<ResponsesStreamEvent>[] = [];
  let summary: TurnSummary | undefined;
  while (true) {
    const next = await iter.next();
    if (next.done) {
      summary = next.value;
      break;
    }
    downstreamFrames.push(next.value);
  }
  return { downstreamFrames, summary: summary!, records };
};

const loopState = () => ({ iterationCount: 1, remainingToolCalls: undefined });

test('parseServerToolArguments repairs malformed JSON and returns an object', () => {
  assertEquals(parseServerToolArguments('{not json'), { 'not json': null });
});

test('parseServerToolArguments returns null for non-object values', () => {
  assertEquals(parseServerToolArguments('[1,2,3]'), null);
  assertEquals(parseServerToolArguments('"hello"'), null);
  assertEquals(parseServerToolArguments('42'), null);
  assertEquals(parseServerToolArguments('null'), null);
});

test('parseServerToolArguments returns empty object for empty args', () => {
  assertEquals(parseServerToolArguments(''), {});
});

const consumeTurn = async (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  state: Parameters<typeof consumeTurnStreaming>[1],
  isFirstTurn: boolean,
): Promise<DrainResult> => {
  const records: DispatchRecord[] = [];
  return await drain(
    consumeTurnStreaming(frames, state, isFirstTurn, new Map([[SHIM_TOOL_NAME, recordingDispatcher(records)]]), loopState(), []),
    records,
  );
};

test('consumeTurn first turn synthesizes response.created with the once-per-request synthesized id (not the upstream id)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated('upstream_x'), mkResponseInProgress('upstream_x'), mkResponseCompleted()),
    state,
    true,
  );

  assertEquals(eventTypesOf(result.downstreamFrames), ['response.created', 'response.in_progress']);
  const created = result.downstreamFrames[0];
  assert(created.type === 'event');
  const createdEv = created.event as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  // Downstream id is the shim-synthesized value (stable cross-turn);
  // upstream's id is captured nowhere and never exposed downstream.
  assertEquals(createdEv.response.id, state.synthesizedResponseId);
  assert(state.synthesizedResponseId.startsWith('resp_shim_'));
});

test('consumeTurn synthesizes response.created with the upstream-reported model (no client fallback)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r', object: 'response', model: 'gpt-5.4-2025-01-20', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  const created = result.downstreamFrames.find(f => f.type === 'event' && f.event.type === 'response.created');
  assert(created?.type === 'event');
  const ev = created.event as Extract<ResponsesStreamEvent, { type: 'response.created' }>;
  assertEquals(ev.response.model, 'gpt-5.4-2025-01-20');
  assertEquals(state.lastSeenModel, 'gpt-5.4-2025-01-20');
});

test('consumeTurn throws when upstream response.created has no model field (no client fallback)', async () => {
  const state = createMergeState();
  const iter = consumeTurnStreaming(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r', object: 'response', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        } as never,
      }),
      mkResponseCompleted(),
    ),
    state,
    true,
    new Map([[SHIM_TOOL_NAME, recordingDispatcher([])]]),
    loopState(),
    [],
  );
  let thrown: unknown;
  try {
    while (!(await iter.next()).done) { /* drain */ }
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof Error);
  assert((thrown as Error).message.includes('upstream `response.created` did not report a `model`'));
});

test('consumeTurn captures upstream-reported model and writes it into MergeState', async () => {
  // Subsequent turns / terminal synthesizers read merge.lastSeenModel.
  const state = createMergeState();
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r', object: 'response', model: 'gpt-5.5-2025-09-01', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  assertEquals(state.lastSeenModel, 'gpt-5.5-2025-09-01');
});

test('consumeTurn re-captures upstream-reported model when later turns change it', async () => {
  // Multi-turn safety: if upstream reports a different model later
  // (unlikely but possible), the latest value wins so the synthesized
  // terminal frame mirrors what upstream actually served last.
  const state = createMergeState();
  state.lastSeenModel = 'gpt-5.5-2025-09-01';
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r2', object: 'response', model: 'gpt-5.6-2025-12-01', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    false,
  );
  assertEquals(state.lastSeenModel, 'gpt-5.6-2025-12-01');
});

test('consumeTurn does NOT capture upstream response.id (downstream uses the shim-synthesized id only)', async () => {
  // Upstream's id rotates per turn and the shim never exposes it
  // downstream — `synthesizedResponseId` is the single cross-turn
  // identity the client correlates against. Verify upstream's id
  // doesn't slip into any MergeState field.
  const state = createMergeState();
  const before = state.synthesizedResponseId;
  state.lastSeenModel = 'gpt-5';
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'resp_turn2_rotated', object: 'response', model: 'gpt-5', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        },
      }),
      mkResponseCompleted(),
    ),
    state,
    false,
  );
  assertEquals(state.synthesizedResponseId, before);
});

test('consumeTurn keeps previous upstream-reported model when a later turn omits it', async () => {
  // Turns without `model` on response.created (legal under the spec
  // even if unusual) keep the previous capture so terminal frames stay
  // stable rather than reverting to undefined.
  const state = createMergeState();
  state.lastSeenModel = 'gpt-5.5-2025-09-01';
  await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'response.created',
        response: {
          id: 'r2', object: 'response', output: [], output_text: '', status: 'in_progress',
          error: null, incomplete_details: null,
        } as never,
      }),
      mkResponseCompleted(),
    ),
    state,
    false,
  );
  assertEquals(state.lastSeenModel, 'gpt-5.5-2025-09-01');
});

test('consumeTurn second turn swallows upstream response.created and in_progress', async () => {
  const state = createMergeState();
  state.sequenceNumber = 100;
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseInProgress(), mkResponseCompleted()),
    state,
    false,
  );
  assertEquals(eventTypesOf(result.downstreamFrames), []);
});

test('consumeTurn intercepts the shim tool and does NOT forward its 4 events', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallArgsDelta(0, '{"search_q'),
      mkFunctionCallArgsDelta(0, 'uery":[{"q":"hello"}]}'),
      mkFunctionCallArgsDone(0, '{"search_query":[{"q":"hello"}]}'),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"hello"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 1);
  assertEquals(result.records[0].intercepted, {
    callId: 'cc_1',
    name: SHIM_TOOL_NAME,
    arguments: { search_query: [{ q: 'hello' }] },
  });
  assertEquals(result.summary.dispatched.length, 1);
  const downstreamTypes = eventTypesOf(result.downstreamFrames);
  for (const t of [
    'response.output_item.added',
    'response.output_item.done',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
  ]) {
    assertFalse(downstreamTypes.includes(t));
  }
  assertFalse(result.summary.sawClientToolCall);
});

test('consumeTurn intercepts two shim calls within one turn', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_o', SHIM_TOOL_NAME),
      mkFunctionCallDone(0, 'cc_o', SHIM_TOOL_NAME, '{"open":[{"ref_id":"https://x"}]}'),
      mkFunctionCallAdded(1, 'cc_f', SHIM_TOOL_NAME),
      mkFunctionCallDone(1, 'cc_f', SHIM_TOOL_NAME, '{"find":[{"ref_id":"https://x","pattern":"p"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  assertEquals(result.records.length, 2);
  assertEquals(result.records[0].intercepted.arguments, { open: [{ ref_id: 'https://x' }] });
  assertEquals(result.records[1].intercepted.arguments, { find: [{ ref_id: 'https://x', pattern: 'p' }] });
});

test('consumeTurn synthesizes response.failed when upstream terminates without closing a shim call', async () => {
  // A shim call reservation that never receives `output_item.done` is
  // an upstream protocol violation: the model intended a tool call,
  // the gateway accepted the reservation, but the close frame never
  // arrived. Without explicit detection here the reservation is
  // silently swallowed — the loop sees an empty `dispatched`, treats
  // the turn as "no tool call this turn", and emits success on a turn
  // that actually had unfinished tool intent. Promote to a synthesized
  // `response.failed` so the gateway surfaces the violation.
  const state = createMergeState();
  const records: DispatchRecord[] = [];
  const result = await drain(
    consumeTurnStreaming(
      framesOf(
        mkResponseCreated(),
        mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
        mkFunctionCallArgsDelta(0, '{"x":'),
        mkFunctionCallArgsDelta(0, '1}'),
        // No function_call.done — dispatcher never fires.
        mkResponseCompleted(),
      ),
      state,
      true,
      new Map([[SHIM_TOOL_NAME, recordingDispatcher(records)]]),
      loopState(),
      [],
    ),
    records,
  );
  assertEquals(result.summary.dispatched.length, 0);
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<UpstreamTerminal, { kind: 'failed' }>;
  assert(ts.response.error!.message.includes('without closing shim call items'));
  assert(ts.response.error!.message.includes('response.completed'));
});

test('consumeTurn dispatches at function_call.done with .done args canonical over deltas', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallArgsDelta(0, '{"stale":'),
      mkFunctionCallArgsDelta(0, '1}'),
      mkFunctionCallArgsDone(0, '{"search_query":[{"q":"x"}]}'),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"x"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  assertEquals(result.records[0].intercepted.arguments, { search_query: [{ q: 'x' }] });
});

test('consumeTurn live-forwards non-shim function_calls and sets sawClientToolCall', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_real',
          call_id: 'cc_x',
          name: 'my_other_tool',
          arguments: '',
          status: 'in_progress',
        } as never,
      }),
      mkFunctionCallArgsDone(0, '{}', 'fc_upstream_mismatch'),
      mkFunctionCallDone(0, 'cc_x', 'my_other_tool', '{}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertEquals(result.summary.sawClientToolCall, true);

  const types = eventTypesOf(result.downstreamFrames);
  assert(types.includes('response.created'));
  assert(types.includes('response.output_item.added'));
  assert(types.includes('response.output_item.done'));
  assert(types.includes('response.function_call_arguments.done'));

  const added = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added');
  assert(added?.type === 'event');
  const addedEv = added.event as Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;
  assertEquals(addedEv.output_index, 0);
  assertEquals(addedEv.item.type, 'function_call');
  const argsDone = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.function_call_arguments.done');
  assert(argsDone?.type === 'event');
  assertEquals((argsDone.event as { item_id: string }).item_id, 'fc_real');
});

test('consumeTurn live-forwards custom_tool_call items and sets sawClientToolCall', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkCustomToolCallAdded(0, 'cc_y', 'my_custom_tool'),
      mkCustomToolCallInputDelta(0, 'free'),
      mkCustomToolCallInputDelta(0, '-form input'),
      mkCustomToolCallInputDone(0, 'free-form input'),
      mkCustomToolCallDone(0, 'cc_y', 'my_custom_tool', 'free-form input'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertEquals(result.summary.sawClientToolCall, true);

  const types = eventTypesOf(result.downstreamFrames);
  assert(types.includes('response.output_item.added'));
  assert(types.includes('response.custom_tool_call_input.delta'));
  assert(types.includes('response.custom_tool_call_input.done'));
  assert(types.includes('response.output_item.done'));
});

test('consumeTurn forwards reasoning items with rewritten output_index', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  const added = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added');
  assert(added?.type === 'event');
  const ev = added.event as Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;
  assertEquals(ev.output_index, 0);
  assertEquals(ev.item.type, 'reasoning');
  assertEquals(state.accumulatedOutput.size, 1);
  assertEquals(state.accumulatedOutput.get(0)?.type, 'reasoning');
});

test('consumeTurn single iteration ending in message: forwards full message lifecycle live', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkMessageAdded(0),
      mkMessageDone(0, 'hi'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertFalse(result.summary.sawClientToolCall);
  assertEquals(state.accumulatedOutput.size, 1);
  assertEquals(state.accumulatedOutput.get(0)?.type, 'message');
  const types = eventTypesOf(result.downstreamFrames);
  assertEquals(types, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_item.done',
  ]);
});

test('consumeTurn one shim call then message in same turn: FORWARDS the message live (shim call is consumed)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"hi"}]}'),
      mkMessageAdded(1),
      mkMessageDone(1, 'intermediate text'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 1);
  assertEquals(state.accumulatedOutput.size, 1);
  // Recording dispatcher doesn't emit lifecycle frames so the shim's
  // reserved slot stays empty in accumulatedOutput, but outputIndex was
  // still bumped. The message therefore lands at index 1.
  assertEquals(state.accumulatedOutput.get(1)?.type, 'message');
  assertEquals(eventTypesOf(result.downstreamFrames), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_item.done',
  ]);
});

test('consumeTurn forwards content_part / output_text / annotation events live with rewritten item_id', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkMessageAdded(0),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.content_part.added',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        delta: 'hello ',
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.annotation.added',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        annotation_index: 0,
        annotation: {
          type: 'url_citation',
          url: 'https://x',
          title: 'X',
          start_index: 0,
          end_index: 5,
        },
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        text: 'hello world',
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.content_part.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: 'hello world' },
      }),
      mkMessageDone(0, 'hello world'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 0);
  assertEquals(eventTypesOf(result.downstreamFrames), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.annotation.added',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
  ]);

  // Message-child events get item_id rewritten onto the
  // downstream-minted `msg_<downstreamIndex>` (0 here).
  for (const f of result.downstreamFrames) {
    if (f.type !== 'event') continue;
    const ev = f.event as { item_id?: string };
    if (ev.item_id !== undefined) {
      assertEquals(ev.item_id, 'msg_0');
    }
  }
});

test('consumeTurn rewrites any structurally indexed child event without an event-type allowlist', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkMessageAdded(0),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.future_child.delta',
        item_id: 'msg_upstream',
        output_index: 0,
        delta: 'future',
      } as unknown as ResponsesStreamEvent),
      mkMessageDone(0, 'future'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  const futureFrame = result.downstreamFrames.find(f =>
    f.type === 'event' && (f.event as { type: string }).type === 'response.future_child.delta');
  assert(futureFrame?.type === 'event');
  assertEquals((futureFrame.event as { output_index: number }).output_index, 0);
  assertEquals((futureFrame.event as { item_id: string }).item_id, 'msg_0');
});

test('consumeTurn swallows future indexed events attached to an intercepted server tool call', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.future_function_call_arguments.delta',
        item_id: 'fc_hidden',
        output_index: 0,
        delta: 'hidden',
      } as unknown as ResponsesStreamEvent),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"q"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertFalse(result.downstreamFrames.some(f =>
    f.type === 'event' && (f.event as { type: string }).type === 'response.future_function_call_arguments.delta'));
});

test('consumeTurn preserves upstream message item.id (no fabrication) when upstream supplies one', async () => {
  // Native upstream wire fixtures attach `id` to message items (see
  // openai-dotnet/tests/SessionRecords/ResponsesToolTests/WebSearchCallAsync.json
  // lines 65-223). When upstream provides item.id, child events
  // (`output_text.delta`, `content_part.added`, …) carry the SAME id
  // upstream emits. Fabricating `msg_<downstreamIndex>` here would
  // make child events mismatch the item's `output_item.added.item.id`.
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
          // Upstream-provided id.
          id: 'msg_xyz_real_id',
        } as never,
      }),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_xyz_real_id',
        output_index: 0,
        content_index: 0,
        delta: 'hi',
      }),
      mkMessageDone(0, 'hi'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  // Child events keep upstream's id verbatim, not rewritten to msg_0.
  const deltaFrame = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_text.delta');
  assert(deltaFrame?.type === 'event');
  assertEquals((deltaFrame.event as { item_id: string }).item_id, 'msg_xyz_real_id');
  // The forwarded `output_item.added` carries the same upstream id.
  const addedFrame = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added');
  assert(addedFrame?.type === 'event');
  const addedItem = (addedFrame.event as { item: { id?: string } }).item;
  assertEquals(addedItem.id, 'msg_xyz_real_id');
});

test('consumeTurn forwards message text events live even when mixed with an intercepted search', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"q"}]}'),
      mkMessageAdded(1),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.output_text.delta',
        item_id: 'msg_upstream',
        output_index: 1,
        content_index: 0,
        delta: 'intermediate',
      }),
      mkMessageDone(1, 'intermediate'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertEquals(result.records.length, 1);
  const types = eventTypesOf(result.downstreamFrames);
  assert(types.includes('response.output_item.added'));
  assert(types.includes('response.output_item.done'));
  assert(types.includes('response.output_text.delta'));
});

test('consumeTurn rewrites sequence_number monotonically starting from state.sequenceNumber', async () => {
  const state = createMergeState();
  state.sequenceNumber = 50;
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
      mkResponseCompleted(),
    ),
    state,
    false,
  );

  const seqs = result.downstreamFrames.flatMap(f =>
    f.type === 'event' ? [(f.event as { sequence_number?: number }).sequence_number ?? -1] : []);
  for (let i = 0; i < seqs.length; i++) {
    assertEquals(seqs[i], 50 + i);
  }
  assertEquals(state.sequenceNumber, 50 + seqs.length);
});

test('consumeTurn allocates contiguous downstream output_index across mixed item types (live-forwarded function_call included)', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
      mkFunctionCallAdded(1, 'cc_x', 'my_other_tool'),
      mkFunctionCallDone(1, 'cc_x', 'my_other_tool', '{}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  const liveAdded = result.downstreamFrames.flatMap(f =>
    f.type === 'event' && f.event.type === 'response.output_item.added'
      ? [(f.event as { output_index: number }).output_index]
      : []);
  assertEquals(liveAdded, [0, 1]);
  assertEquals(state.outputIndex, 2);
});

test('consumeTurn extracts usage from response.completed envelope', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkResponseCompleted({
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 5 },
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.turnUsage, {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    input_tokens_details: { cached_tokens: 10 },
    output_tokens_details: { reasoning_tokens: 5 },
  });
});

test('consumeTurn returns empty turnUsage when upstream response.completed lacks usage', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseCompleted()),
    state,
    true,
  );
  assertEquals(result.summary.turnUsage, {});
});

test('consumeTurn does NOT emit response.completed in downstreamFrames', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseCompleted({ input_tokens: 1, output_tokens: 1, total_tokens: 2 })),
    state,
    true,
  );
  assertFalse(eventTypesOf(result.downstreamFrames).includes('response.completed'));
});

test('consumeTurn sets terminalStatus.kind = completed when upstream response.completed arrives', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), mkResponseCompleted()),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'completed');
});

test('consumeTurn surfaces upstream response.failed as terminalStatus.failed with the upstream envelope', async () => {
  const state = createMergeState();
  const failedResponse: ResponsesResult = {
    id: 'upstream_x',
    object: 'response',
    model: 'test-model',
    output: [],
    output_text: '',
    status: 'failed',
    error: { message: 'upstream gave up', type: 'server_error', code: '500' },
    incomplete_details: null,
  };
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.failed',
        response: failedResponse,
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<UpstreamTerminal, { kind: 'failed' }>;
  assertEquals(ts.response.error?.code, '500');
});

test('consumeTurn surfaces upstream response.incomplete as terminalStatus.incomplete', async () => {
  const state = createMergeState();
  const incompleteResponse: ResponsesResult = {
    id: 'upstream_x',
    object: 'response',
    model: 'test-model',
    output: [],
    output_text: '',
    status: 'incomplete',
    error: null,
    incomplete_details: null,
  };
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'response.incomplete',
        response: incompleteResponse,
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'incomplete');
});

test('consumeTurn surfaces bare `error` event as terminalStatus.failed with a synthesized envelope', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream blew up',
        code: 'server_error',
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<UpstreamTerminal, { kind: 'failed' }>;
  assertEquals(ts.response.status, 'failed');
  assertEquals(ts.response.error?.message, 'upstream blew up');
  assertEquals(ts.response.error?.code, 'server_error');
  // Synthesized envelope's id is the shim-synthesized response id
  // — upstream's id is not exposed downstream.
  assertEquals(ts.response.id, state.synthesizedResponseId);
});

test('consumeTurn defaults missing `error.code` to spec-defined `server_error` (no synthetic `unknown_upstream_error` literal)', async () => {
  // A bare upstream `{type: 'error'}` frame without a `code` field
  // falls back to the OpenAPI `ResponsesErrorCode` enum value
  // `'server_error'`. The previous `'unknown_upstream_error'`
  // synthetic literal is not in the enum and typed SDKs (openai-python
  // `Literal[...]` with strict Pydantic validation, openai-node
  // literal union, openai-go `ResponsesErrorCode string` named type)
  // reject unknown values at parse time. Reference:
  // https://github.com/openai/openai-openapi/blob/master/openapi.yaml
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream blew up without a code',
      }),
    ),
    state,
    true,
  );
  const ts = result.summary.terminalStatus as Extract<UpstreamTerminal, { kind: 'failed' }>;
  assertEquals(ts.response.error?.code, 'server_error');
  // No synthetic `type` — the spec's ResponsesError schema defines
  // only `{code, message}` and the upstream `error` frame doesn't
  // carry a `type` field on the wire either.
  assertFalse('type' in (ts.response.error as object));
});

test('consumeTurn treats empty-string `error.code` as missing (same fallback as undefined)', async () => {
  // `??` only handles null/undefined; an explicit `code: ''` would
  // survive and reach the wire as the synthesized response.failed's
  // `error.code`, where typed SDKs reject the empty string the same
  // way they reject any non-enum value. Mirror `parseUpstreamErrorBody`'s
  // `length > 0` guard for shape parity between the bare-error path
  // and the upstream-error HTTP body path.
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream blew up with empty code',
        code: '',
      }),
    ),
    state,
    true,
  );
  const ts = result.summary.terminalStatus as Extract<UpstreamTerminal, { kind: 'failed' }>;
  assertEquals(ts.response.error?.code, 'server_error');
});

test('consumeTurn surfaces bare `error` event arriving BEFORE response.created as terminalStatus `bare-error-pre-shell` (no synthesized response)', async () => {
  // The success-path "no fallback" contract refuses to synthesize a
  // wire-valid response envelope that lies about the served identity.
  // The bare-error path's job is the opposite: surface upstream's
  // failure verbatim. But when the failure happens before any
  // identity is captured (truncated TLS, transport drop, intermediate
  // proxy injection), we cannot synthesize a wire-valid
  // `ResponsesResult` (id and model are required, not nullable). Use
  // a distinct terminal status `bare-error-pre-shell` so the shim's
  // outer loop can short-circuit to a non-events `upstream-error`
  // result instead of fabricating empty-string identity fields.
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      eventFrame<ResponsesStreamEvent>({
        type: 'error',
        message: 'upstream dropped before response shell',
      }),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'bare-error-pre-shell');
  const ts = result.summary.terminalStatus as Extract<UpstreamTerminal, { kind: 'bare-error-pre-shell' }>;
  assertEquals(ts.error.message, 'upstream dropped before response shell');
  // Spec-defined fallback (no `code` on upstream's error frame). See
  // the matching test above for the in-shell path; both default to
  // `server_error` from the `ResponsesErrorCode` enum.
  assertEquals(ts.error.code, 'server_error');
});

test('consumeTurnStreaming yields forwarded frames before upstream completes', async () => {
  const state = createMergeState();

  let upstreamPullCount = 0;
  const upstream: ProtocolFrame<ResponsesStreamEvent>[] = [
    mkResponseCreated(),
    mkReasoningAdded(0, 'rs_1'),
    mkReasoningDone(0, 'rs_1'),
    mkResponseCompleted(),
  ];
  const countedFrames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> = (async function* () {
    for (const f of upstream) {
      upstreamPullCount += 1;
      yield f;
    }
  })();

  const records: DispatchRecord[] = [];
  const iter = consumeTurnStreaming(
    countedFrames,
    state,
    true,
    new Map([[SHIM_TOOL_NAME, recordingDispatcher(records)]]),
    loopState(),
    [],
  );

  const first = await iter.next();
  assert(!first.done);
  assert(first.value.type === 'event');
  assertEquals(first.value.event.type, 'response.created');
  assertEquals(upstreamPullCount, 1);

  while (!(await iter.next()).done) { /* drain */ }
});

test('dispatcher start frames yield IN-LINE at function_call.done (shim call slot precedes later items)', async () => {
  const state = createMergeState();
  let dispatchOrder = 0;
  const records: DispatchRecord[] = [];
  const dispatcher = ({ intercepted }: { intercepted: InterceptedFunctionCall }) => {
    records.push({ intercepted });
    const order = ++dispatchOrder;
    return [{
      id: `synthetic-${order}`,
      startItem: { type: 'web_search_call', id: `synthetic-${order}`, status: 'in_progress' },
      startEvents: [{ type: 'response.web_search_call.in_progress' } as never],
      async *run() {
        return {
          item: { type: 'web_search_call', id: `synthetic-${order}`, status: 'completed', action: { type: 'search', query: 'q', queries: ['q'] }, results: [] } as never,
          endEvents: [{ type: 'response.web_search_call.completed' } as never],
        };
      },
    } satisfies ServerToolResultSlot];
  };

  const result = await drain(
    consumeTurnStreaming(
      framesOf(
        mkResponseCreated(),
        mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
        mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"hi"}]}'),
        mkMessageAdded(1),
        mkMessageDone(1, 'after'),
        mkResponseCompleted(),
      ),
      state,
      true,
      new Map([[SHIM_TOOL_NAME, dispatcher]]),
      loopState(),
      [],
    ),
    records,
  );

  const types = eventTypesOf(result.downstreamFrames);
  const syntheticIdx = types.indexOf('response.web_search_call.in_progress');
  const messageAddedIdx = result.downstreamFrames.findIndex(f =>
    f.type === 'event'
    && f.event.type === 'response.output_item.added'
    && f.event.item.type === 'message');
  assert(syntheticIdx >= 0);
  assert(messageAddedIdx >= 0);
  assert(syntheticIdx < messageAddedIdx, `expected dispatcher start frame BEFORE later live items (synth=${syntheticIdx}, msgAdded=${messageAddedIdx})`);
});

test('shim call output_index is reserved at output_item.added so interleaved items get later indices', async () => {
  // Reserving at `.added` (rather than `.done`) keeps a non-shim call
  // item arriving between added and done from stealing the shim's
  // would-be downstream index.
  const state = createMergeState();
  const dispatcher = () => [] as ServerToolResultSlot[];

  const interleaved = eventFrame<ResponsesStreamEvent>({
    type: 'response.image_generation_call.in_progress',
    output_index: 5,
    item_id: 'ig_x',
  } as unknown as ResponsesStreamEvent);

  const records: DispatchRecord[] = [];
  const result = await drain(
    consumeTurnStreaming(
      framesOf(
        mkResponseCreated(),
        mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
        interleaved,
        mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"x"}]}'),
        mkResponseCompleted(),
      ),
      state,
      true,
      new Map([[SHIM_TOOL_NAME, dispatcher]]),
      loopState(),
      [],
    ),
    records,
  );

  const igForwarded = result.downstreamFrames.find(f =>
    f.type === 'event' && f.event.type === 'response.image_generation_call.in_progress');
  assert(igForwarded?.type === 'event');
  assertEquals((igForwarded.event as { output_index: number }).output_index, 1);
});

test('consumeTurn live-forwards indexed progress events without hardcoded event-type lists', async () => {
  const state = createMergeState();
  const inProgress = eventFrame<ResponsesStreamEvent>({
    type: 'response.image_generation_call.in_progress',
    output_index: 0,
    item_id: 'ig_1',
  });
  const completed = eventFrame<ResponsesStreamEvent>({
    type: 'response.image_generation_call.completed',
    output_index: 0,
    item_id: 'ig_1',
  });
  const result = await consumeTurn(
    framesOf(mkResponseCreated(), inProgress, completed, mkResponseCompleted()),
    state,
    true,
  );
  const forwarded = result.downstreamFrames
    .filter(f => f.type === 'event')
    .map(f => (f.event as { type: string }).type);
  assert(forwarded.includes('response.image_generation_call.in_progress'));
  assert(forwarded.includes('response.image_generation_call.completed'));
  const indices = result.downstreamFrames.flatMap(f =>
    f.type === 'event' && (f.event.type as string).startsWith('response.image_generation_call')
      ? [(f.event as { output_index: number }).output_index]
      : []);
  assertEquals(new Set(indices).size, 1);
});

test('consumeTurn keeps swallowing keepalive/ping-shape events that lack output_index', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      eventFrame<ResponsesStreamEvent>({ type: 'keepalive' } as unknown as ResponsesStreamEvent),
      eventFrame<ResponsesStreamEvent>({ type: 'ping' }),
      mkResponseCompleted(),
    ),
    state,
    true,
  );
  const types = eventTypesOf(result.downstreamFrames);
  assertFalse(types.includes('keepalive'));
  assertFalse(types.includes('ping'));
});

test('consumeTurn synthesizes terminalStatus.failed when upstream stream ends without any terminal event', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkReasoningAdded(0, 'rs_1'),
      mkReasoningDone(0, 'rs_1'),
    ),
    state,
    true,
  );
  assertEquals(result.summary.terminalStatus.kind, 'failed');
  const ts = result.summary.terminalStatus as Extract<UpstreamTerminal, { kind: 'failed' }>;
  assertEquals(ts.response.status, 'failed');
  assert(ts.response.error!.message.includes('without a terminal event'));
});

test('createMergeState starts with empty sparse usage accumulator and a synthesized response id', () => {
  const s = createMergeState();
  assert(s.synthesizedResponseId.startsWith('resp_shim_'));
  assertEquals(s.lastSeenModel, null);
  assertEquals(s.sequenceNumber, 0);
  assertEquals(s.outputIndex, 0);
  assertEquals(s.accumulatedOutput.size, 0);
  // Sparse on purpose: a field appears only when at least one turn
  // observed it, so we never fabricate `cached_tokens: 0` for an
  // upstream that doesn't report cache.
  assertEquals(s.accumulatedUsage, {});
});

test('materializeAccumulatedOutput returns items in output_index order regardless of insertion order', () => {
  const s = createMergeState();
  const itemA: ResponsesOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] };
  const itemB: ResponsesOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'B' }] };
  const itemC: ResponsesOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'C' }] };
  s.accumulatedOutput.set(2, itemC);
  s.accumulatedOutput.set(0, itemA);
  s.accumulatedOutput.set(1, itemB);
  const out = materializeAccumulatedOutput(s);
  assertEquals(out.length, 3);
  assertEquals((out[0] as { content: { text: string }[] }).content[0].text, 'A');
  assertEquals((out[1] as { content: { text: string }[] }).content[0].text, 'B');
  assertEquals((out[2] as { content: { text: string }[] }).content[0].text, 'C');
});

test('materializeAccumulatedOutput drops holes in the index sequence (defensive)', () => {
  const s = createMergeState();
  const itemB: ResponsesOutputItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'B' }] };
  s.accumulatedOutput.set(1, itemB);
  const out = materializeAccumulatedOutput(s);
  assertEquals(out.length, 1);
  assertEquals((out[0] as { content: { text: string }[] }).content[0].text, 'B');
});

test('sumUsage sums every subfield including details', () => {
  const a = {
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    input_tokens_details: { cached_tokens: 5 },
    output_tokens_details: { reasoning_tokens: 3 },
  };
  const b = {
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    input_tokens_details: { cached_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 30 },
  };
  assertEquals(sumUsage(a, b), {
    input_tokens: 110,
    output_tokens: 220,
    total_tokens: 330,
    input_tokens_details: { cached_tokens: 55 },
    output_tokens_details: { reasoning_tokens: 33 },
  });
});

test('sumUsage omits detail subfields neither side reported (sparse)', () => {
  const a = { input_tokens: 10, output_tokens: 20, total_tokens: 30 };
  const b = { input_tokens: 100, output_tokens: 200, total_tokens: 300 };
  assertEquals(sumUsage(a, b), {
    input_tokens: 110,
    output_tokens: 220,
    total_tokens: 330,
  });
});

test('sumUsage of two empty operands returns an empty object (no fabricated zeros)', () => {
  assertEquals(sumUsage({}, {}), {});
});

test('sumUsage with one-sided details preserves the field (treats missing side as 0)', () => {
  const a = {
    input_tokens: 10,
    output_tokens: 0,
    total_tokens: 10,
    input_tokens_details: { cached_tokens: 4 },
  };
  const b = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  assertEquals(sumUsage(a, b), {
    input_tokens: 11,
    output_tokens: 1,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 4 },
  });
});

// ── Slot run() contract ────────────────────────────────────────────────

test('ServerToolResultSlot run() yields mid events in order then returns the terminal', async () => {
  const slot: ServerToolResultSlot = {
    id: 'ig_1',
    startItem: { type: 'image_generation_call', status: 'in_progress' },
    startEvents: [{ type: 'response.image_generation_call.in_progress' }],
    async *run() {
      yield { type: 'response.image_generation_call.partial_image', partial_image_index: 0 };
      yield { type: 'response.image_generation_call.partial_image', partial_image_index: 1 };
      return {
        item: { type: 'image_generation_call', status: 'completed' },
        endEvents: [{ type: 'response.image_generation_call.completed' }],
      };
    },
  };

  const mid: unknown[] = [];
  const gen = slot.run();
  let step = await gen.next();
  while (!step.done) {
    mid.push(step.value.partial_image_index);
    step = await gen.next();
  }
  assertEquals(mid, [0, 1]);
  assertEquals(step.value.item.status, 'completed');
  assertEquals(step.value.endEvents.map(e => e.type), ['response.image_generation_call.completed']);
});

test('ServerToolResultSlot run() yields nothing and returns the terminal', async () => {
  const slot: ServerToolResultSlot = {
    id: 'ws_1',
    startItem: { type: 'web_search_call', status: 'in_progress' },
    startEvents: [],
    async *run() {
      return {
        item: { type: 'web_search_call', status: 'completed' },
        endEvents: [{ type: 'response.web_search_call.completed' }],
      };
    },
  };

  const gen = slot.run();
  const first = await gen.next();
  assert(first.done === true);
  assertEquals(first.value.item.status, 'completed');
});

// ── Echo restore on `response.tools` / `response.tool_choice` ─────────────
//
// The shim rewrites the request's hosted `web_search` to a function tool
// before upstream; on echo (per OpenAI spec, `Response` composes
// `ResponseProperties`, so `tools` and `tool_choice` are echoed) the
// synthesized envelope must restore the canonical hosted form so the
// client never sees the gateway-internal function tool name.

const mkResponseCreatedWithTools = (
  tools: ResponsesTool[],
  toolChoice?: ResponsesToolChoice,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    type: 'response.created',
    response: {
      ...emptyResult('upstream_test', 'in_progress'),
      tools,
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    },
  });

const mkResponseCompletedWithTools = (
  tools: ResponsesTool[],
  toolChoice?: ResponsesToolChoice,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame<ResponsesStreamEvent>({
    type: 'response.completed',
    response: {
      ...emptyResult('upstream_test', 'completed'),
      tools,
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    },
  });

const findResponseCompleted = (
  frames: ProtocolFrame<ResponsesStreamEvent>[],
): Extract<ResponsesStreamEvent, { type: 'response.completed' }> => {
  for (const f of frames) {
    if (f.type === 'event' && f.event.type === 'response.completed') {
      return f.event;
    }
  }
  throw new Error('no response.completed in downstream frames');
};

test('echo restore swaps the injected function tool back to the canonical hosted web_search', async () => {
  makeStubDeps();
  // Upstream's echoed `tools` includes the function tool the shim
  // injected plus an ordinary client function tool — restore should
  // touch only the injected one. (Spec defaults like
  // `additionalProperties:false` that Copilot injects on function
  // tools must pass through verbatim on the non-shim tool.)
  const upstreamEchoedTools: ResponsesTool[] = [
    {
      type: 'function',
      name: SHIM_TOOL_NAME,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      strict: false,
      description: 'gateway-internal',
    },
    {
      type: 'function',
      name: 'get_weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
      strict: true,
      description: null as unknown as string,
    },
  ];
  const shim = withResponsesWebSearchShim;
  const inv = makeInvocation({
    payload: {
      tools: [
        { type: 'web_search' },
        { type: 'function', name: 'get_weather', parameters: { type: 'object' }, strict: false },
      ],
    },
  });
  const script = scriptedRun([[
    mkResponseCreatedWithTools(upstreamEchoedTools),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompletedWithTools(upstreamEchoedTools),
  ]]);

  const { frames } = await runShimAndDrain(shim, inv, makeGatewayCtx(), script.run);

  const completed = findResponseCompleted(frames);
  assert(Array.isArray(completed.response.tools));
  assertEquals(completed.response.tools!.length, 2);
  assertEquals(completed.response.tools![0].type, 'web_search');
  assertEquals((completed.response.tools![0] as { search_context_size: string }).search_context_size, 'medium');
  assertEquals((completed.response.tools![0] as { return_token_budget: string }).return_token_budget, 'default');
  // Pass-through tool retains its upstream-enriched shape.
  assertEquals(completed.response.tools![1].type, 'function');
  assertEquals((completed.response.tools![1] as { name: string }).name, 'get_weather');
});

test('echo restore preserves client-supplied filters / user_location on the canonical hosted form', async () => {
  makeStubDeps();
  const userLoc = { city: 'Tokyo', country: 'JP' };
  const filters = { allowed_domains: ['weather.gov'] };
  const upstreamEchoedTools: ResponsesTool[] = [
    { type: 'function', name: SHIM_TOOL_NAME, parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false },
  ];
  const inv = makeInvocation({ payload: { tools: [{ type: 'web_search', filters, user_location: userLoc }] } });
  const script = scriptedRun([[
    mkResponseCreatedWithTools(upstreamEchoedTools),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompletedWithTools(upstreamEchoedTools),
  ]]);

  const { frames } = await runShimAndDrain(withResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  const completed = findResponseCompleted(frames);
  assertEquals(completed.response.tools![0].type, 'web_search');
  assertEquals((completed.response.tools![0] as { filters: typeof filters }).filters, filters);
  assertEquals((completed.response.tools![0] as { user_location: typeof userLoc }).user_location, userLoc);
});

test('duplicate hosted web_search entries silently collapse into one echoed canonical', async () => {
  makeStubDeps();
  const inv = makeInvocation({
    payload: {
      tools: [
        { type: 'web_search', search_context_size: 'high' },
        { type: 'web_search' },
      ],
    },
  });
  // Upstream sees exactly one function tool because the framework
  // dedupes before run().
  const upstreamEchoedTools: ResponsesTool[] = [
    { type: 'function', name: SHIM_TOOL_NAME, parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false },
  ];
  const script = scriptedRun([[
    mkResponseCreatedWithTools(upstreamEchoedTools),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompletedWithTools(upstreamEchoedTools),
  ]]);

  const { frames } = await runShimAndDrain(withResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  // Request side: only one function tool was sent upstream.
  assertEquals(inv.payload.tools?.length, 1);
  assertEquals(inv.payload.tools?.[0].type, 'function');
  // Response side: one restored canonical entry, preserving the FIRST
  // hosted block's `search_context_size`.
  const completed = findResponseCompleted(frames);
  assertEquals(completed.response.tools!.length, 1);
  assertEquals(completed.response.tools![0].type, 'web_search');
  assertEquals((completed.response.tools![0] as { search_context_size: string }).search_context_size, 'high');
});

test('echo restore swaps the function-typed tool_choice back to a hosted tool_choice', async () => {
  makeStubDeps();
  const upstreamEchoedTools: ResponsesTool[] = [
    { type: 'function', name: SHIM_TOOL_NAME, parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false },
  ];
  const inv = makeInvocation({
    payload: {
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
    },
  });
  const script = scriptedRun([[
    mkResponseCreatedWithTools(upstreamEchoedTools, { type: 'function', name: SHIM_TOOL_NAME }),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompletedWithTools(upstreamEchoedTools, { type: 'function', name: SHIM_TOOL_NAME }),
  ]]);

  const { frames } = await runShimAndDrain(withResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  // Request side: tool_choice was rewritten to the function form.
  assertEquals(inv.payload.tool_choice, { type: 'function', name: SHIM_TOOL_NAME });
  const completed = findResponseCompleted(frames);
  assertEquals(completed.response.tool_choice, { type: 'web_search' });
});

test('echo restore leaves a non-injected function-typed tool_choice untouched', async () => {
  makeStubDeps();
  // Upstream echoes a tool_choice naming a CLIENT-supplied function
  // tool, not the shim's. Restore must not rewrite that.
  const upstreamEchoedTools: ResponsesTool[] = [
    { type: 'function', name: SHIM_TOOL_NAME, parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false },
    { type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false },
  ];
  const inv = makeInvocation({
    payload: {
      tools: [
        { type: 'web_search' },
        { type: 'function', name: 'get_weather', parameters: { type: 'object' }, strict: false },
      ],
      tool_choice: { type: 'function', name: 'get_weather' },
    },
  });
  const script = scriptedRun([[
    mkResponseCreatedWithTools(upstreamEchoedTools, { type: 'function', name: 'get_weather' }),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompletedWithTools(upstreamEchoedTools, { type: 'function', name: 'get_weather' }),
  ]]);

  const { frames } = await runShimAndDrain(withResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  const completed = findResponseCompleted(frames);
  assertEquals(completed.response.tool_choice, { type: 'function', name: 'get_weather' });
});

test('upstream that does not echo `tools` produces a synthesized envelope without `tools`', async () => {
  makeStubDeps();
  const inv = makeInvocation({ payload: { tools: [{ type: 'web_search' }] } });
  // mkResponseCompleted() carries no `tools` field — simulating an
  // upstream that simply omits the echo.
  const script = scriptedRun([messageTurn('done')]);

  const { frames } = await runShimAndDrain(withResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  const completed = findResponseCompleted(frames);
  assertEquals(completed.response.tools, undefined);
  assertEquals(completed.response.tool_choice, undefined);
});
