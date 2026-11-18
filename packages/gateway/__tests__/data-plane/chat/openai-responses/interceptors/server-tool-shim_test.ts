import { beforeEach, expect, test, vi } from 'vitest';

import { inputErrorResult } from '../../../../../src/data-plane/chat/openai-responses/errors.ts';
import { withOpenAIResponsesServerToolShim } from '../../../../../src/data-plane/chat/openai-responses/interceptors/server-tool-shim.ts';
import {
  consumeTurnStreaming,
  createMergeState,
  resolveServerToolName,
  type InterceptedFunctionCall,
  type ServerToolResultSlot,
  type ServerToolRegistration,
  type TurnSummary,
} from '../../../../../src/data-plane/chat/openai-responses/interceptors/server-tool-shim.ts';
import { imageGenerationServerTool, expandImageGenerationCall } from '../../../../../src/data-plane/chat/openai-responses/interceptors/server-tools/image-generation.ts';
import { SHIM_TOOL_NAME, expandWebSearchCall, webSearchServerTool } from '../../../../../src/data-plane/chat/openai-responses/interceptors/server-tools/web-search.ts';
import type { OpenAIResponsesInterceptor, OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import type { ChatGatewayCtx } from '../../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { SidecarDomain } from '../../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { resolveAlphaSearchDispatcher } from '../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts';
import type { AlphaSearchDispatcher } from '../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts';
import { resolveConfiguredWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/provider.ts';
import type {
  ConfiguredWebSearchProvider,
  WebSearchConfig,
  WebSearchFetchPageRequest,
  WebSearchFetchPageResult,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '../../../../../src/data-plane/tools/web-search/types.ts';
import { getRepo, initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { decodeCanonicalBase64, encodeBase64, eventFrame } from '@floway-dev/protocols/common';
import type { BillableUsage, ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type {
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesOutputItemEx,
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesInputWebSearchCall,
  OpenAIResponsesOutputWebSearchCall,
  OpenAIResponsesPayloadEx,
  OpenAIResponsesResultEx,
  OpenAIResponsesStreamEventEx,
  OpenAIResponsesTool,
  OpenAIResponsesToolChoice,
  OpenAIResponsesWebSearchAction,
} from '@floway-dev/protocols/openai-responses';
import { eventResult, type EventResult, type ExecuteResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, assertFalse, assertRejects, stubModelCandidate } from '@floway-dev/test-utils';
import { routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

const withOpenAIResponsesWebSearchShim = withOpenAIResponsesServerToolShim([webSearchServerTool]);

const replaySearch: ServerToolRegistration = () => ({
  type: 'active', baseToolName: 'web_search',
  expandHistoryItem: (item, replayData) => item.type === 'web_search_call' ? expandWebSearchCall(item, replayData) : undefined,
});
const replayImage: ServerToolRegistration = () => ({ type: 'active', baseToolName: 'image_generation', expandHistoryItem: (item, replay) => item.type === 'image_generation_call' ? expandImageGenerationCall(item, replay) : undefined });

const searchHistory = async (
  ctx: ChatGatewayCtx,
  id: string,
  item: Extract<CanonicalOpenAIResponsesInputItem, { type: 'web_search_call' | 'image_generation_call' }> = { type: 'web_search_call', id, status: 'completed', action: { type: 'search', queries: [id] } },
): Promise<CanonicalOpenAIResponsesInputItem[]> => {
  const encoded = await ctx.sidecarCodecFactory.codecFor(SidecarDomain.OpenAIResponsesHostedToolCall).encode({
    v: 1,
    type: item.type,
    functionCall: { type: 'function_call', call_id: id, name: item.type === 'web_search_call' ? 'web_search' : 'image_generation', arguments: '{}', status: 'completed' },
    data: item.type === 'web_search_call' ? { action: item.action, results: [] } : {
      action: item.action, revised_prompt: item.revised_prompt, size: item.size, quality: item.quality, output_format: item.output_format, background: item.background,
    },
  });
  return [{ type: 'reasoning', id: `rs_${id}`, summary: [], encrypted_content: encoded }, item];
};

const historyShape = (items: CanonicalOpenAIResponsesInputItem[]) => items.map(item => item.type === 'function_call' || item.type === 'function_call_output'
  ? `${item.type}:${item.call_id}` : item.type === 'message' ? `message:${item.role}` : item.type);

const boundSearchItem = {
  type: 'web_search_call' as const, id: 'ws_bound', status: 'completed' as const,
  action: { type: 'search' as const, queries: ['original'] },
  results: [{ type: 'text_result' as const, url: 'https://example.com', title: 'result', snippet: 'original result' }],
};
const boundImageItem = {
  type: 'image_generation_call' as const, id: 'ig_bound', status: 'completed' as const,
  result: 'aGVsbG8=', revised_prompt: 'original prompt', output_format: 'png' as const, action: 'generate' as const,
  size: '1024x1024' as const, quality: 'high' as const, background: 'opaque' as const,
};

test.each([
  { change: 'search query', original: boundSearchItem, changed: { ...boundSearchItem, action: { type: 'search' as const, queries: ['different'] } } },
  { change: 'search to image', original: boundSearchItem, changed: boundImageItem },
])('shim rejects the ordinal replay candidate when call inputs change: $change', async ({ original, changed }) => {
  const ctx = makeGatewayCtx();
  const [carrier] = await searchHistory(ctx, 'signed_original', original);
  const inv = makeInvocation({ payload: { input: [carrier, changed] } });
  await runShimAndDrain(withOpenAIResponsesServerToolShim([replaySearch, replayImage]), inv, ctx, async () => {
    const calls = inv.payload.input.filter(item => item.type === 'function_call');
    assertEquals(calls.length, 1);
    assertFalse(calls[0].call_id === 'signed_original');
    assertEquals(calls[0].name, changed.type === 'web_search_call' ? 'web_search' : 'image_generation');
    assertFalse(inv.payload.input.some(item => item.type === 'reasoning'));
    const output = inv.payload.input.find(item => item.type === 'function_call_output');
    assert(output?.type === 'function_call_output');
    assertEquals(output.call_id, calls[0].call_id);
    return await scriptedRun([messageTurn('done')]).run();
  });
});

test.each([
  { change: 'search results', original: boundSearchItem, changed: { ...boundSearchItem, results: [] } },
])('shim retains replay when only call outputs change: $change', async ({ original, changed }) => {
  const ctx = makeGatewayCtx();
  const [carrier] = await searchHistory(ctx, 'signed_original', original);
  const inv = makeInvocation({ payload: { input: [carrier, changed] } });
  await runShimAndDrain(withOpenAIResponsesServerToolShim([replaySearch, replayImage]), inv, ctx, async () => {
    assertEquals(inv.payload.input.filter(item => item.type === 'function_call').map(item => item.call_id), ['signed_original']);
    assertEquals(inv.payload.input.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['signed_original']);
    return await scriptedRun([messageTurn('done')]).run();
  });
});

test('hosted history pairs replay sidecars by ordinal within a turn', async () => {
  const ctx = makeGatewayCtx();
  const codec = ctx.sidecarCodecFactory.codecFor(SidecarDomain.OpenAIResponsesHostedToolCall);
  const decode = vi.spyOn(codec, 'decode');
  const codecFor = vi.spyOn(ctx.sidecarCodecFactory, 'codecFor').mockReturnValue(codec);
  const [firstReplay, firstCall] = await searchHistory(ctx, 'first');
  const secondCall = { type: 'image_generation_call' as const, id: 'public-image', status: 'completed' as const, result: 'aGVsbG8=', revised_prompt: 'second' };
  const [secondReplay] = await searchHistory(ctx, 'second', secondCall);
  const native: CanonicalOpenAIResponsesInputItem = { type: 'reasoning', id: 'upstream', summary: [], encrypted_content: 'native-opaque' };
  const client: CanonicalOpenAIResponsesInputItem = { type: 'custom_tool_call', call_id: 'client', name: 'client', input: 'input' };
  const input = [firstReplay, firstCall, native, secondCall, client, secondReplay];
  const original = structuredClone(input);
  const seen: string[] = [];
  const registration: ServerToolRegistration = () => ({
    type: 'active', baseToolName: 'hosted',
    expandHistoryItem: (item, replayData) => {
      if (item.type !== 'web_search_call' && item.type !== 'image_generation_call') return undefined;
      assert(replayData !== undefined);
      assertEquals(Object.keys(replayData), ['data']);
      seen.push(item.type === 'web_search_call' ? (replayData.data as { action: { queries: string[] } }).action.queries[0] : (replayData.data as { revised_prompt: string }).revised_prompt);
      return { callSource: 'replay', output: 'result' };
    },
  });
  const inv = makeInvocation({ payload: { input } });
  await runShimAndDrain(withOpenAIResponsesServerToolShim([registration]), inv, ctx, async () => {
    assertEquals(seen, ['first', 'second']);
    assertEquals(inv.payload.input.filter(item => item.type === 'function_call').map(item => item.call_id), ['first', 'second']);
    assertEquals(inv.payload.input.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['first', 'second']);
    assertEquals(inv.payload.input.filter(item => item.type === 'reasoning'), [native]);
    assertEquals(inv.payload.input.filter(item => item.type === 'custom_tool_call'), [client]);
    assertEquals(decode.mock.calls.map(([value]) => value), input.filter(item => item.type === 'reasoning').map(item => item.encrypted_content));
    assertEquals(codecFor.mock.calls.at(-1), [SidecarDomain.OpenAIResponsesHostedToolCall]);
    return await scriptedRun([messageTurn('done')]).run();
  });
  assertEquals(input, original);
});

test('hosted replay ordinals reset at a user-side boundary', async () => {
  const ctx = makeGatewayCtx();
  const [orphan] = await searchHistory(ctx, 'orphan');
  const [replay, call] = await searchHistory(ctx, 'next');
  const boundary: CanonicalOpenAIResponsesInputItem = { type: 'function_call_output', call_id: 'client', output: 'result' };
  const inv = makeInvocation({ payload: { input: [orphan, boundary, call, replay] } });
  await runShimAndDrain(withOpenAIResponsesServerToolShim([replaySearch]), inv, ctx, async () => {
    assertEquals(historyShape(inv.payload.input), ['function_call_output:client', 'function_call:next', 'function_call_output:next']);
    assertEquals(inv.payload.input[0], boundary);
    return await scriptedRun([messageTurn('done')]).run();
  });
});

test('hosted history consumes a recognized replay sidecar without a matching call', async () => {
  const ctx = makeGatewayCtx();
  const [carrier] = await searchHistory(ctx, 'original');
  const inv = makeInvocation({ payload: { input: [carrier] } });
  await runShimAndDrain(withOpenAIResponsesServerToolShim([replaySearch]), inv, ctx, async () => {
    assertEquals(historyShape(inv.payload.input), []);
    return await scriptedRun([messageTurn('done')]).run();
  });
});

test('hosted history preserves a tampered replay carrier', async () => {
  const ctx = makeGatewayCtx();
  const history = await searchHistory(ctx, 'original');
  const carrier = history[0];
  assert(carrier.type === 'reasoning' && typeof carrier.encrypted_content === 'string');
  const bytes = decodeCanonicalBase64(carrier.encrypted_content)!;
  bytes[0] ^= 1;
  carrier.encrypted_content = encodeBase64(bytes);
  const inv = makeInvocation({ payload: { input: history } });
  const registration: ServerToolRegistration = () => ({
    type: 'active', baseToolName: 'web_search',
    expandHistoryItem: (item, replayData) => {
      if (item.type !== 'web_search_call') return undefined;
      assertEquals(replayData, undefined);
      return expandWebSearchCall(item, replayData);
    },
  });
  await runShimAndDrain(withOpenAIResponsesServerToolShim([registration]), inv, ctx, async () => {
    assertEquals(inv.payload.input[0], carrier);
    const [, call, output] = inv.payload.input;
    assert(call.type === 'function_call' && output.type === 'function_call_output');
    assertEquals(output.call_id, call.call_id);
    assertEquals(inv.payload.input.length, 3);
    return await scriptedRun([messageTurn('done')]).run();
  });
});

test.each([
  null,
  { type: 'web_search_call', functionCall: { type: 'function_call', call_id: 'call', name: 'web_search', arguments: 1 } },
])('authenticated invalid hosted replay data exposes the producer error: %j', async payload => {
  const ctx = makeGatewayCtx();
  const encrypted_content = await ctx.sidecarCodecFactory.codecFor(SidecarDomain.OpenAIResponsesHostedToolCall).encode(payload);
  const inv = makeInvocation({
    payload: {
      input: [
        { type: 'reasoning', id: 'rs_invalid', summary: [], encrypted_content },
        { type: 'web_search_call', id: 'original', status: 'completed' },
      ],
    },
  });
  await assertRejects(
    () => runShimAndDrain(withOpenAIResponsesServerToolShim([replaySearch]), inv, ctx, async () => { throw new Error('Must fail before upstream'); }),
    TypeError, 'Invalid hosted-tool replay data',
  );
});

test('history places mixed hosted results after the call batch and preserves tool inventories', async () => {
  const ctx = makeGatewayCtx();
  const tail: CanonicalOpenAIResponsesInputItem = { type: 'reasoning', id: 'rs_tail', summary: [], encrypted_content: 'opaque' };
  const additional: CanonicalOpenAIResponsesInputItem = { type: 'additional_tools', role: 'developer', tools: [] };
  const loaded: CanonicalOpenAIResponsesInputItem = { type: 'tool_search_output', call_id: 'load', execution: 'client', tools: [] };
  const source: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'message', role: 'user', content: 'question' },
    tail,
    { type: 'message', role: 'assistant', content: 'before calls' },
    ...await searchHistory(ctx, 'search'),
    { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: 'aGVsbG8=', output_format: 'png' },
    additional, loaded,
    { type: 'message', role: 'user', content: 'next' },
  ];
  const original = structuredClone(source);
  const inv = makeInvocation({ payload: { input: source } });
  const shim = withOpenAIResponsesServerToolShim([replayImage, replaySearch]);
  await runShimAndDrain(shim, inv, ctx, async () => {
    assertEquals(historyShape(inv.payload.input), [
      'message:user', 'reasoning', 'message:assistant', 'function_call:search', 'function_call:cc_from_ig_1',
      'function_call_output:search', 'function_call_output:cc_from_ig_1', 'message:user', 'additional_tools', 'tool_search_output', 'message:user',
    ]);
    assertEquals(inv.payload.input[1], tail);
    const image = inv.payload.input[7];
    assert(image.type === 'message' && Array.isArray(image.content));
    assertEquals(image.content[1], { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', detail: 'auto' });
    return await scriptedRun([messageTurn('done')]).run();
  });
  assertEquals(source, original);
});

const emptyResult = (id: string, status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id,
  object: 'response',
  model: 'test-model',
  output: [],
  status,
  error: null,
  incomplete_details: null,
});

const mkResponseCreated = (responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.created',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkResponseQueued = (responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.queued',
    response: emptyResult(responseId, 'queued'),
  });

const mkResponseInProgress = (responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.in_progress',
    response: emptyResult(responseId, 'in_progress'),
  });

const mkFunctionCallAdded = (outputIndex: number, callId: string, name: string): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
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

const mkFunctionCallArgsDone = (outputIndex: number, args: string, itemId = `fc_${outputIndex}`): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: args,
  });

const mkFunctionCallDone = (outputIndex: number, callId: string, name: string, args: string): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
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

const mkMessageAdded = (outputIndex: number): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: {
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    },
  });

const mkMessageDone = (outputIndex: number, text: string): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  });

// We replace `resolveConfiguredWebSearchProvider` because real provider
// construction (`createTavilyWebSearchProvider` etc.) would otherwise
// pull in network-hitting backend impls. Tests insert a WebSearchConfig
// row through the in-memory repo so `loadWebSearchConfig` returns
// non-default values; the mock then ignores the config and returns a
// test stub. Tests that need a specific configured state set
// `mockResolveConfigured.mockReturnValue(...)` per call.
vi.mock('../../../../../src/data-plane/tools/web-search/provider.ts');
vi.mock('../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts');

const mkResponseCompleted = (
  usage?: OpenAIResponsesResultEx['usage'],
  responseId = 'upstream_test',
): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.completed',
    response: {
      ...emptyResult(responseId, 'completed'),
      ...(usage !== undefined ? { usage } : {}),
    },
  });

const mkResponseIncomplete = (
  incompleteDetails?: { reason: string },
  responseId = 'upstream_test',
): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.incomplete',
    response: {
      ...emptyResult(responseId, 'incomplete'),
      ...(incompleteDetails !== undefined ? { incomplete_details: incompleteDetails } : {}),
    },
  });

// Integration tests for the OpenAI Responses web_search shim. Internal helpers
// are unit-tested through focused web-search server-tool suites; this file covers
// activation gating, tool rewrite, multi-turn loop, downstream stream
// merge invariants, and error propagation.

// ── Test scaffolding ──────────────────────────────────────────────────────

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  pricing: null,
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
const mockResolveAlpha = vi.mocked(resolveAlphaSearchDispatcher);

// Seed a per-test InMemoryRepo and a default tavily search config so
// `loadWebSearchConfig()` returns a non-default value. The actual provider
// construction is short-circuited by the module mock above; tests
// override `mockResolveConfigured` to point at a stub backend.
beforeEach(() => {
  mockResolveAlpha.mockReset();
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'test-key' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
  } satisfies WebSearchConfig);
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
  targetApi?: 'openaiResponses' | 'anthropicMessages' | 'openaiChatCompletions';
  enabledFlags?: ReadonlySet<FlagId>;
  payload?: Partial<OpenAIResponsesPayloadEx>;
}

const makeInvocation = (overrides: InvocationOverrides = {}): OpenAIResponsesInvocation => ({
  candidate: stubModelCandidate({
    ...(overrides.enabledFlags ? { enabledFlags: overrides.enabledFlags } : {}),
    model: { id: 'claude-x', endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} } },
  }),
  // Default openai-chat-completions so existing tests exercise the
  // function_call_output path. Tests that care about a specific target
  // set targetApi explicitly.
  targetApi: overrides.targetApi ?? 'openaiChatCompletions',
  payload: {
    model: 'claude-x',
    stream: true,
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: [{ type: 'web_search' }],
    // Opt the wire item into `results` so most tests can inspect them
    // directly; the new include-gating tests explicitly omit this and
    // assert the wire-item shape without `results`.
    include: ['web_search_call.results'],
    ...overrides.payload,
  } as CanonicalOpenAIResponsesPayload,
  headers: new Headers(),
  action: 'generate',
});

const makeGatewayCtx = (apiKeyId: string = 'k1') =>
  mockChatGatewayCtx({ apiKeyId, wantsStream: true });

const collectFrames = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const f of iter) out.push(f);
  return out;
};

// The shim streams lazily: backend calls, ctx.payload.input mutation, and
// subsequent run() calls all happen inside the events generator. Tests
// asserting on side-effects MUST drain the events stream first.
const runShimAndDrain = async (
  shim: OpenAIResponsesInterceptor,
  inv: OpenAIResponsesInvocation,
  gatewayCtx: ChatGatewayCtx,
  run: () => Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>>,
): Promise<{
  result: ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>;
  frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[];
}> => {
  const result = await shim(inv, gatewayCtx, run);
  const frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = result.type === 'events'
    ? await collectFrames(result.events)
    : [];
  return { result, frames };
};

// Drive run() N times with one scripted event array per call. Reaches past
// the scripted length crashes the test — invariant violations stay loud.
type ScriptedTurn = ProtocolFrame<OpenAIResponsesStreamEventEx>[];

interface ScriptedRun {
  run: () => Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>>;
  callCount: () => number;
}

const scriptedRun = (turns: ScriptedTurn[]): ScriptedRun => {
  let i = 0;
  return {
    run: async () => {
      if (i >= turns.length) throw new Error(`unexpected run() call ${i + 1}; only ${turns.length} turn(s) scripted`);
      const frames = turns[i++];
      const iterable: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = (async function* () {
        for (const f of frames) yield f;
      })();
      const result: EventResult<ProtocolFrame<OpenAIResponsesStreamEventEx>> = {
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

const eventPayloads = (frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): OpenAIResponsesStreamEventEx[] =>
  frames.filter(f => f.type === 'event').map(f => (f as { type: 'event'; event: OpenAIResponsesStreamEventEx }).event);

const outputItemDoneEvents = (frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): Array<Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }>> =>
  eventPayloads(frames)
    .filter((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }> => e.type === 'response.output_item.done');

// ── Activation gating ──────────────────────────────────────────────────

test('shim no-ops when targetApi=responses and flag is off', async () => {
  const { backend } = makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation({
    targetApi: 'openaiResponses',
    enabledFlags: new Set<FlagId>(),
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

test('shim rewrites hosted tools inside additional_tools at their input position', async () => {
  const item = { type: 'additional_tools' as const, role: 'developer' as const, id: 'at_1', tools: [{ type: 'web_search' as const }] };
  const { backend } = makeStubDeps();
  const inv = makeInvocation({
    targetApi: 'openaiResponses',
    enabledFlags: new Set<FlagId>(['openai-responses-web-search-shim']),
    payload: {
      tools: undefined,
      tool_choice: { type: 'web_search' },
      input: [
        { type: 'message', role: 'user', content: 'before' },
        item,
        { type: 'message', role: 'user', content: 'after' },
      ],
    },
  });
  const args = JSON.stringify({ search_query: [{ q: 'test' }] });
  const script = scriptedRun([fcTurn(0, 'call_1', SHIM_TOOL_NAME, args), messageTurn('done')]);

  await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  assertEquals(inv.payload.tools, undefined);
  assertEquals(inv.payload.tool_choice, 'auto');
  assertEquals(inv.payload.input[0], { type: 'message', role: 'user', content: 'before' });
  const rewritten = inv.payload.input[1];
  assert(rewritten.type === item.type);
  assertEquals(rewritten.tools.map(tool => tool.type), ['function']);
  assertEquals((rewritten.tools[0] as { name: string }).name, SHIM_TOOL_NAME);
  assertEquals(rewritten.id, 'at_1');
  assertEquals(backend.calls.length, 1);
});

// ── Per-tool fields propagate ──────────────────────────────────────────

test('shim propagates filters / user_location / search_context_size to backend', async () => {
  const { backend } = makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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

test('public output and internal continuations replay complete assistant/tool turns through the same expansion', async () => {
  const { backend } = makeStubDeps();
  const inv = makeInvocation();
  const ctx = makeGatewayCtx();
  const inputs: CanonicalOpenAIResponsesInputItem[][] = [];
  const searchTurn = (id: string): ScriptedTurn => {
    const tail: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: `rs_${id}`, summary: [], encrypted_content: `opaque_${id}`, status: 'completed' };
    return [
      ...searchCallTurn(0, id, id).slice(0, -1),
      eventFrame({ type: 'response.output_item.added', output_index: 1, item: tail }),
      eventFrame({ type: 'response.output_item.done', output_index: 1, item: tail }),
      mkResponseCompleted(),
    ];
  };
  const script = scriptedRun([searchTurn('first'), searchTurn('second'), messageTurn('answer')]);
  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, ctx, async () => {
    inputs.push(structuredClone(inv.payload.input));
    return await script.run();
  });
  assertEquals(script.callCount(), 3);
  assertEquals(backend.calls.length, 2);
  const firstTurn = ['reasoning', 'function_call:first', 'function_call_output:first'];
  const secondTurn = ['reasoning', 'function_call:second', 'function_call_output:second'];
  assertEquals(historyShape(inputs[1]), ['message:user', ...firstTurn]);
  assertEquals(historyShape(inputs[2]), ['message:user', ...firstTurn, ...secondTurn]);
  const output = findResponseCompleted(frames).response.output;
  assertEquals(output.map(item => item.type), ['reasoning', 'reasoning', 'web_search_call', 'reasoning', 'reasoning', 'web_search_call', 'message']);
  const next = makeInvocation({
    payload: {
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        ...JSON.parse(JSON.stringify(output)) as CanonicalOpenAIResponsesInputItem[],
        { type: 'message', role: 'user', content: 'next' },
      ],
    },
  });
  await runShimAndDrain(withOpenAIResponsesWebSearchShim, next, makeGatewayCtx(), async () => {
    assertEquals(historyShape(next.payload.input), ['message:user', ...firstTurn, ...secondTurn, 'message:assistant', 'message:user']);
    return await scriptedRun([messageTurn('followup')]).run();
  });
  assertEquals(backend.calls.length, 2);
});

test.each([{ hostedFirst: true, interleaved: true }, { hostedFirst: false, interleaved: false }])('hosted output preserves mixed parallel call order on client replay (hosted first: $hostedFirst, interleaved: $interleaved)', async ({ hostedFirst, interleaved }) => {
  const { backend } = makeStubDeps();
  const inv = makeInvocation();
  const ctx = makeGatewayCtx();
  const hosted = { type: 'function_call' as const, id: 'fc_hosted', call_id: 'hosted', name: SHIM_TOOL_NAME, arguments: '{"search_query":[{"q":"test"}]}', status: 'completed' as const };
  const client = { type: 'function_call' as const, id: 'fc_client', call_id: 'client', name: 'client_tool', arguments: '{}', status: 'completed' as const };
  const calls = hostedFirst ? [hosted, client] : [client, hosted];
  const tail: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_tail', summary: [], encrypted_content: 'native' };
  const events: ScriptedTurn = [mkResponseCreated()];
  const added = calls.map((item, index) => eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } }));
  const done = calls.map((item, index) => eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', output_index: index, item }));
  events.push(...(interleaved ? [...added, ...done.toReversed()] : added.flatMap((frame, index) => [frame, done[index]])));
  events.push(
    eventFrame({ type: 'response.output_item.added', output_index: 2, item: tail }),
    eventFrame({ type: 'response.output_item.done', output_index: 2, item: tail }),
    mkResponseCompleted(),
  );
  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, ctx, scriptedRun([events]).run);
  const output = findResponseCompleted(frames).response.output;
  const hostedIndex = output.findIndex(item => item.type === 'web_search_call');
  assert(hostedIndex > 0 && output[hostedIndex - 1].type === 'reasoning');
  assert(output.findIndex(item => item.type === 'reasoning') < output.findIndex(item => item.type === 'web_search_call'));
  const next = makeInvocation({
    payload: { input: [...output as CanonicalOpenAIResponsesInputItem[], { type: 'function_call_output', call_id: 'client', output: 'client result' }] },
  });
  await runShimAndDrain(withOpenAIResponsesWebSearchShim, next, makeGatewayCtx(), async () => {
    assertEquals(next.payload.input.filter(item => item.type === 'function_call').map(item => item.call_id), calls.map(item => item.call_id));
    assertEquals(next.payload.input.filter(item => item.type === 'function_call_output').map(item => item.call_id), ['hosted', 'client']);
    const lastCall = next.payload.input.findLastIndex(item => item.type === 'function_call');
    const firstResult = next.payload.input.findIndex(item => item.type === 'function_call_output');
    assert(lastCall < firstResult);
    return await scriptedRun([messageTurn('done')]).run();
  });
  assertEquals(backend.calls.length, 1);
});

test.each([
  { raw: '{search_query:[{q:"repaired"}]}', query: 'repaired' },
])('hosted search executes parsed arguments while replaying the original string: $raw', async ({ raw, query }) => {
  const { backend } = makeStubDeps();
  const inv = makeInvocation();
  const ctx = makeGatewayCtx();
  const script = scriptedRun([fcTurn(0, 'call_raw', SHIM_TOOL_NAME, raw), messageTurn('answer')]);
  const inputs: CanonicalOpenAIResponsesInputItem[][] = [];
  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, ctx, async () => {
    inputs.push(structuredClone(inv.payload.input));
    return await script.run();
  });
  assertEquals(backend.calls.length, 1);
  assertEquals((backend.calls[0].request as WebSearchProviderRequest).query, query);
  const restored = inputs[1].find(item => item.type === 'function_call');
  assert(restored?.type === 'function_call');
  assertEquals(restored.call_id, 'call_raw');
  assertEquals(restored.arguments, raw);
  const output = JSON.parse(JSON.stringify(findResponseCompleted(frames).response.output)) as CanonicalOpenAIResponsesInputItem[];
  const next = makeInvocation({ payload: { input: [...output, { type: 'message', role: 'user', content: 'next' }] } });
  await runShimAndDrain(withOpenAIResponsesWebSearchShim, next, makeGatewayCtx(), async () => {
    assertEquals(next.payload.input.find(item => item.type === 'function_call'), restored);
    return await scriptedRun([messageTurn('done')]).run();
  });
  assertEquals(backend.calls.length, 1);
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
  const shim = withOpenAIResponsesWebSearchShim;
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

// ── Iteration cap exhausted ───────────────────────────────────────────

test('iteration cap returns the iteration-cap notice without backend call on cap+1', async () => {
  const { backend } = makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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
  const input = inv.payload.input as CanonicalOpenAIResponsesInputItem[];
  const lastOutput = input[input.length - 1];
  assert(lastOutput.type === 'function_call_output');
  assert((lastOutput as { output: string }).output.includes('iteration limit (30)'));

  // The cap-exceeded turn still synthesizes a full web_search_call
  // lifecycle: 31 done events = 30 successful + 1 capped. The capped
  // call surfaces as the schema-error shape (action.type='search' with
  // the cap diagnostic in queries[0]) rather than the original query —
  // the shim call is rejected before backend dispatch.
  const wsCallDone = events.filter((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }> =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'web_search_call');
  assertEquals(wsCallDone.length, 31);
  const capItem = wsCallDone[30].item as OpenAIResponsesOutputWebSearchCall;
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
  const shim = withOpenAIResponsesWebSearchShim;
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
  const wsCallDone = events.filter((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }> =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'web_search_call');
  assertEquals(wsCallDone.length, 1);
  const item = wsCallDone[0].item as OpenAIResponsesOutputWebSearchCall;
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
  const shim = withOpenAIResponsesWebSearchShim;
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
  const wsCallDone = events.filter((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }> =>
    e.type === 'response.output_item.done'
    && (e as { item?: { type?: string } }).item?.type === 'web_search_call');
  assertEquals(wsCallDone.length, 1);
  const item = wsCallDone[0].item as OpenAIResponsesOutputWebSearchCall;
  assertEquals(item.action?.type, 'search');
  const action = item.action as Extract<OpenAIResponsesWebSearchAction, { type: 'search' }>;
  assertEquals(action.queries, ['q1', 'q2', 'q3']);

  // Three backend search calls (one per query, parallel).
  const searchCalls = backend.calls.filter(c => c.kind === 'search');
  assertEquals(searchCalls.length, 3);
  assertEquals(calls.sort(), ['q1', 'q2', 'q3']);

  // Merged results in entry order.
  assertEquals(item.results?.map(r => r.url), ['https://r/q1', 'https://r/q2', 'https://r/q3']);
});

// ── Backend search failure ────────────────────────────────────────────

// ── Domain filter input validation ────────────────────────────────────

test('invalid request registration preserves an upstream error type and null code', async () => {
  const shim = withOpenAIResponsesServerToolShim([() => ({
    type: 'invalid-request',
    message: 'native image error',
    param: 'input',
    errorType: 'image_generation_user_error',
    code: null,
  })]);
  const result = await shim(
    makeInvocation(),
    makeGatewayCtx(),
    () => Promise.reject(new Error('run should not be called')),
  );
  assert(result.type === 'api-error');
  const body = JSON.parse(new TextDecoder().decode(result.body)) as {
    error: { message: string; type: string; param: string | null; code: string | null };
  };
  assertEquals(body.error, {
    message: 'native image error',
    type: 'image_generation_user_error',
    param: 'input',
    code: null,
  });
});

test('later hosted validation keeps original paths before another tool rewrites the carrier', async () => {
  makeStubDeps();
  const inv = makeInvocation({
    payload: {
      tools: undefined,
      input: [{
        type: 'additional_tools', role: 'developer',
        tools: [
          { type: 'web_search' },
          { type: 'web_search_preview' },
          { type: 'image_generation', size: '512x512' },
        ],
      }],
    },
  });
  const originalInput = structuredClone(inv.payload.input);
  const shim = withOpenAIResponsesServerToolShim([webSearchServerTool, imageGenerationServerTool]);

  const result = await shim(inv, makeGatewayCtx(), async () => {
    throw new Error('Invalid request reached upstream');
  });

  assert(result.type === 'api-error');
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { param: string } };
  assertEquals(body.error.param, 'input[0].tools[2].size');
  assertEquals(inv.payload.input, originalInput);
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
  const shim = withOpenAIResponsesWebSearchShim;
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

test.each([
  { field: 'allowed_domains', raw: 'https://quora.com/', message: 'Invalid domain' },
] as const)('$field entry $raw rejects with 400 before any upstream or backend call', async ({ field, raw, message }) => {
  const { result, backend, script } = await runShimWithDomainEntry(field, raw);
  assert(result.type === 'api-error');
  assertEquals(result.status, 400);
  assertEquals(script.callCount(), 0);
  assertEquals(backend.calls.length, 0);
  const body = JSON.parse(new TextDecoder().decode(result.body)) as { error: { type: string; param: string; message: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'tools');
  assert(body.error.message.includes(message));
});

// ── Domain filter blocks open ─────────────────────────────────────────

test('find blocked by domain filter emits wire-side find_in_page (not open_page) with the original url/pattern', async () => {
  // When a `find` op's URL is blocked or its fetch fails, the
  // resulting `web_search_call` item must keep `action.type:
  // 'find_in_page'` and carry the model's original url + pattern.
  // Switching to `open_page` would silently change `action.type`
  // mid-result and confuse clients that branch on it to render the
  // model's intent (e.g. a UI that draws a "searched inside <url>
  // for <pattern>" badge for find ops only).
  const { backend } = makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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
  const item = wsDones[0].item as OpenAIResponsesOutputWebSearchCall;
  assert(item.action !== undefined);
  assertEquals(item.action.type, 'find_in_page');
  const findAction = item.action as Extract<typeof item.action, { type: 'find_in_page' }>;
  assertEquals(findAction.url, 'https://blocked.com/page');
  assertEquals(findAction.pattern, 'needle');
});

// ── Multi-turn SSE merge invariants ──────────────────────────────────

test('multi-turn merge: output_index unique, sequence_number monotonic, response.created once', async () => {
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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
    .filter((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.added' }> => e.type === 'response.output_item.added')
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
const mkResponseCreatedWithModel = (model: string, responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.created',
    response: { id: responseId, object: 'response', model, output: [], status: 'in_progress', error: null, incomplete_details: null },
  });

const mkResponseInProgressWithModel = (model: string, responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.in_progress',
    response: { id: responseId, object: 'response', model, output: [], status: 'in_progress', error: null, incomplete_details: null },
  });

const mkResponseCompletedWithModel = (model: string, responseId = 'upstream_test'): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.completed',
    response: { id: responseId, object: 'response', model, output: [], status: 'completed', error: null, incomplete_details: null },
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
  const shim = withOpenAIResponsesWebSearchShim;
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

  const created = events.find(e => e.type === 'response.created') as Extract<OpenAIResponsesStreamEventEx, { type: 'response.created' }>;
  const inProgress = events.find(e => e.type === 'response.in_progress') as Extract<OpenAIResponsesStreamEventEx, { type: 'response.in_progress' }>;
  const completed = events.find(e => e.type === 'response.completed') as Extract<OpenAIResponsesStreamEventEx, { type: 'response.completed' }>;
  assertEquals(created.response.model, SERVED_MODEL);
  assertEquals(inProgress.response.model, SERVED_MODEL);
  assertEquals(completed.response.model, SERVED_MODEL);
});

test('shim refuses to synthesize a response envelope when upstream response.created has no model', async () => {
  // No-fallback contract: a missing model on upstream's first
  // response.created is a protocol violation. The `ensureModel()`
  // invariant throws from inside `consumeTurnStreaming`; the throw
  // surfaces through the events generator to the source responder
  // (which reports it upward) rather than being silently swallowed
  // or papered over with `ctx.payload.model`.
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation({ payload: { model: 'gpt-5' } });

  const modelless = eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.created',
    response: { id: 'upstream_x', object: 'response', output: [], status: 'in_progress' } as never,
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

test('usage cached_tokens reported on one turn carries through (last-turn omission does not zero it out)', async () => {
  // Internal sums treat missing fields as 0; the wire output preserves
  // any field at least one turn observed. Turn 1 reports cached_tokens;
  // turn 2 omits it. Final usage must still surface cached_tokens
  // (turn 1's value).
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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
  const completed = events.find((e): e is Extract<OpenAIResponsesStreamEventEx, { type: 'response.completed' }> => e.type === 'response.completed');
  assert(completed !== undefined);
  assertEquals(completed.response.usage?.input_tokens, 150);
  assertEquals(completed.response.usage?.output_tokens, 60);
  assertEquals(completed.response.usage?.total_tokens, 210);
  // cached_tokens is treated as 0 for the missing-turn-2 side; the
  // sum is 7 + 0 = 7 and the field is present on the wire.
  assertEquals(completed.response.usage?.input_tokens_details, { cached_tokens: 7 });
});

test('upstream sends an error event before response.created: shim forwards it without inventing a response', async () => {
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();
  const error = {
    type: 'error' as const,
    message: 'upstream dropped before response shell',
    code: null,
    param: null,
  };
  const errorOnlyTurn: ScriptedTurn = [
    eventFrame<OpenAIResponsesStreamEventEx>(error),
  ];
  const script = scriptedRun([errorOnlyTurn]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  assertEquals(events.length, 1);
  const { sequence_number: sequenceNumber, ...forwarded } = events[0] as typeof error & { sequence_number: number };
  assertEquals(forwarded, error);
  assertEquals(sequenceNumber, 0);
});

test('upstream sends an error event after response.created: shim forwards both events without synthesizing a terminal resource', async () => {
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();
  const createdWith = eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.created',
    response: {
      id: 'resp_captured_id_xyz',
      object: 'response',
      model: 'gpt-5.4-2025-01-20',
      output: [],
      status: 'in_progress',
      error: null,
      incomplete_details: null,
    } as OpenAIResponsesResultEx,
  });
  const diagnostics = { name: 'UpstreamError', cause: { request_id: 'req_failed' }, target_api: 'openaiResponses' };
  const script = scriptedRun([[
    createdWith,
    eventFrame<OpenAIResponsesStreamEventEx>({
      type: 'error',
      message: 'mid-stream upstream blew up',
      code: 'server_error',
      provider_specific_fields: diagnostics,
    }),
  ]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  assertEquals(events.map(event => event.type), ['response.created', 'error']);
  const error = events[1] as Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>;
  assert('message' in error);
  assertEquals(error.message, 'mid-stream upstream blew up');
  assertEquals(error.code, 'server_error');
  assert(error.provider_specific_fields === diagnostics);
});

test('turn-1 iterator throws AFTER response.created: synthesizes response.failed with synthesized id + last-seen model', async () => {
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();
  const cause = { socket: 'upstream-1' };
  const streamError = new Error('connection reset by peer', { cause });
  const failingMidStream: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = (async function* () {
    yield mkResponseCreated('upstream_mid');
    throw streamError;
  })();
  const run = async (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => ({
    type: 'events',
    events: failingMidStream,
    modelIdentity: testTelemetryModelIdentity,
  });

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const terminal = events[events.length - 1];
  assertEquals(terminal.type, 'response.failed');
  const failed = terminal as Extract<OpenAIResponsesStreamEventEx, { type: 'response.failed' }>;
  assertEquals(failed.response.status, 'failed');
  assert(failed.response.id.startsWith('resp_shim_'));
  assertEquals(failed.response.model, 'test-model');
  assertEquals(failed.response.error?.code, 'server_error');
  assert(failed.response.error?.message.includes('connection reset by peer'));
  assert(failed.response.error?.message.includes('Upstream stream failed mid-response'));
  const diagnostics = failed.response.error?.provider_specific_fields;
  assertEquals(diagnostics?.name, 'Error');
  assertEquals(diagnostics?.stack, streamError.stack);
  assert(diagnostics?.cause === cause);
  assertFalse('stack' in (failed.response.error as object));
  assertFalse('type' in (failed.response.error as object));
});

// ── Snapshot pass-through preserves upstream-owned envelope fields ──

test('snapshot pass-through: upstream tools/tool_choice/temperature/parallel_tool_calls/reasoning/service_tier survive synthesized response.created + .completed', async () => {
  // The shim used to build fresh OpenAIResponsesResult shells with hard-
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
  const createdWith = eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.created',
    response: upstreamSnapshot as OpenAIResponsesResultEx,
  });
  const completedWith = eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.completed',
    response: {
      ...upstreamSnapshot,
      status: 'completed',
      // Native upstreams typically add completed_at on the terminal frame.
      completed_at: 1735689700,
    } as OpenAIResponsesResultEx,
  });
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();
  const script = scriptedRun([[createdWith, mkMessageAdded(0), mkMessageDone(0, 'done'), completedWith]]);

  const result = await shim(inv, makeGatewayCtx(), script.run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const created = events.find(e => e.type === 'response.created') as Extract<OpenAIResponsesStreamEventEx, { type: 'response.created' }>;
  const completed = events.find(e => e.type === 'response.completed') as Extract<OpenAIResponsesStreamEventEx, { type: 'response.completed' }>;

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

// ── finalMetadata follows the latest turn's modelIdentity ──────────────

test('finalMetadata resolves with the LATEST turn modelIdentity, not turn 1', async () => {
  // The source responder reads modelIdentity from finalMetadata when
  // recording usage / performance. A multi-turn run where upstream
  // serves a different dated variant on a later turn (Copilot
  // raw-variant selection) must report the latest variant — passing
  // through firstResult.finalMetadata would freeze it to turn 1's
  // modelKey.
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
    runCalls += 1;
    const frames = runCalls === 1
      ? searchCallTurn(0, 'call_1', 'q1')
      : messageTurn('done', 0);
    const iterable: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = (async function* () {
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
        pricing: null,
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

test('include: ["web_search_call.action.sources"] populates action.sources with search-result URLs', async () => {
  // Native OpenAI Responses gates `action.sources` on this exact include
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
  const shim = withOpenAIResponsesWebSearchShim;
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
  const item = wsCallDone.item as OpenAIResponsesOutputWebSearchCall;
  const action = item.action as { type: 'search'; sources?: { type: 'url'; url: string }[] };
  assertEquals(action.sources, [
    { type: 'url', url: 'https://example.com/a' },
    { type: 'url', url: 'https://example.com/b' },
  ]);
});

// ── Mixed-tool turn (shim call + client tool present) ─────────────────

// ── Pass-through of replayed web_search_call from input ────────────────

// ── Input preprocessor: web_search_call items → shim call pair ─────────

test('input preprocessor: each web_search_call item becomes one shim call + function_call_output pair', async () => {
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const replayedSearch: OpenAIResponsesInputWebSearchCall = {
    type: 'web_search_call',
    id: 'ws_old_search',
    status: 'completed',
    action: { type: 'search', queries: ['hello world'] },
    results: [{ type: 'text_result', url: 'https://x', title: 'X', snippet: 'snippet body' }],
  };
  const replayedOpen: OpenAIResponsesInputWebSearchCall = {
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

  const input = inv.payload.input as CanonicalOpenAIResponsesInputItem[];
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
  const shim = withOpenAIResponsesWebSearchShim;
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

  const input = inv.payload.input as CanonicalOpenAIResponsesInputItem[];
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

// ── Provider-config error paths ───────────────────────────────────────────

test('disabled search provider: dispatched op surfaces explanation snippet (no 500 internal-error)', async () => {
  makeStubDeps({
    configured: { type: 'disabled' },
  });
  const shim = withOpenAIResponsesWebSearchShim;
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
    .filter((i): i is OpenAIResponsesOutputWebSearchCall => i.type === 'web_search_call');
  assertEquals(done.length, 1);
  const snippet = done[0].results![0].snippet;
  assert(snippet.includes('not configured'));
});

// ── Streaming-specific behavior ───────────────────────────────────────────

test('shim yields first turn frames BEFORE later turns resolve', async () => {
  // Turn 2's run() never resolves until the test releases its gate. Turn
  // 1's frames must be drainable from the iterator before that resolves;
  // otherwise the iterator would block on the gate.
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();

  let releaseTurn2: (() => void) | undefined;
  const turn2Gate = new Promise<void>(resolve => {
    releaseTurn2 = resolve;
  });

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = (async function* () {
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
      const frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = (async function* () {
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
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();
  // Gate the upstream terminal frame so a buffered implementation would
  // be stuck waiting on it before yielding any byte downstream.
  let releaseTerminal: (() => void) | undefined;
  const terminalGate = new Promise<void>(resolve => {
    releaseTerminal = resolve;
  });
  const run = async (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
    const frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = (async function* () {
      yield mkResponseCreated();
      yield mkResponseInProgress();
      yield mkMessageAdded(0);
      yield eventFrame<OpenAIResponsesStreamEventEx>({
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

test.each([
  {
    body: {
      type: 'error',
      message: 'You exceeded your current quota.',
      code: null,
      param: 'tools',
      provider_specific_fields: { request_id: 'req_flat', retryable: true },
    },
    responseError: null,
  },
  {
    body: {
      type: 'error',
      error: {
        message: 'You exceeded your current quota.',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
        param: null,
        provider_specific_fields: { request_id: 'req_nested', retryable: true },
      },
      trace_id: 'trace_nested',
    },
    responseError: {
      message: 'You exceeded your current quota.',
      type: 'insufficient_quota',
      code: 'insufficient_quota',
      param: null,
      provider_specific_fields: { request_id: 'req_nested', retryable: true },
    },
  },
] as const)('mid-stream HTTP error body becomes a lossless error event followed by response.failed: $body', async ({ body, responseError }) => {
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();

  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
    runCalls += 1;
    if (runCalls === 1) {
      const frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> = (async function* () {
        for (const f of searchCallTurn(0, 'call_1', 'q1')) yield f;
      })();
      return { type: 'events', events: frames, modelIdentity: testTelemetryModelIdentity };
    }
    return {
      type: 'api-error',
      source: 'upstream',
      status: 429,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: new TextEncoder().encode(JSON.stringify(body)),
    };
  };

  const result = await shim(inv, makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const errorIndex = events.findIndex(event => event.type === 'error');
  assert(errorIndex >= 0);
  const error = events[errorIndex] as Extract<OpenAIResponsesStreamEventEx, { type: 'error' }>;
  const { sequence_number: sequenceNumber, ...unstamped } = error;
  assertEquals(unstamped, body);
  assertEquals(typeof sequenceNumber, 'number');

  const failed = events[events.length - 1] as Extract<OpenAIResponsesStreamEventEx, { type: 'response.failed' }>;
  assertEquals(failed.type, 'response.failed');
  assertEquals(failed.response.status, 'failed');
  assertEquals(failed.response.error, responseError);
  assertFalse(events.some(event => event.type === 'response.completed'));
  assertEquals(runCalls, 2);
});

test('upstream response.incomplete after a server tool call keeps synthesized tool output in the terminal response', async () => {
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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
  const terminal = events.at(-1) as Extract<OpenAIResponsesStreamEventEx, { type: 'response.incomplete' }>;

  assertEquals(terminal.type, 'response.incomplete');
  assertEquals(terminal.response.output.map(item => item.type), ['message', 'reasoning', 'web_search_call']);
  assertEquals(Object.hasOwn(terminal.response, 'output_text'), false);
  assertEquals(terminal.response.incomplete_details, { reason: 'max_output_tokens' });
});

// ── function_call_output is plain text on every target ───────────────

const lastFunctionCallOutput = (input: CanonicalOpenAIResponsesInputItem[]): string => {
  const last = input[input.length - 1];
  assert(last.type === 'function_call_output');
  return (last as { output: string }).output;
};

test('responses target with OpenAI passthrough forwards the complete alpha-search command and settings shapes', async () => {
  makeStubDeps();
  await getRepo().webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'test-key' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: true, upstreamId: 'up_codex', model: 'gpt-search' },
  } satisfies WebSearchConfig);
  const call = vi.fn<AlphaSearchDispatcher>(async () => new Response(JSON.stringify({
    encrypted_output: null,
    output: 'alpha output',
    results: [{ type: 'text_result', url: 'https://example.com', title: 'Example', snippet: 'alpha snippet' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  mockResolveAlpha.mockResolvedValue(call);
  const inv = makeInvocation({
    targetApi: 'openaiResponses',
    enabledFlags: new Set<FlagId>(['openai-responses-web-search-shim']),
    payload: {
      tools: [{
        type: 'web_search',
        user_location: { type: 'approximate', country: 'SG' },
        image_settings: { max_results: 4, caption: true },
        allowed_callers: ['direct'],
        external_web_access: 'live',
      }],
    },
  });
  const commands = {
    image_query: [{ q: 'Floway logo', recency: 7, domains: ['floway.dev'] }],
    finance: [{ ticker: 'OPENAI', type: 'equity', market: 'USA' }],
    response_length: 'long',
  };
  const script = scriptedRun([
    fcTurn(0, 'call_1', SHIM_TOOL_NAME, JSON.stringify(commands)),
    messageTurn('done', 0),
  ]);

  await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  assertEquals(lastFunctionCallOutput(inv.payload.input as CanonicalOpenAIResponsesInputItem[]), 'alpha output');
  assertEquals(call.mock.calls[0]?.[0].commands, commands);
  assertEquals(call.mock.calls[0]?.[0].settings, {
    user_location: { type: 'approximate', country: 'SG' },
    image_settings: { max_results: 4, caption: true },
    allowed_callers: ['direct'],
    external_web_access: 'live',
  });
});

test('responses target preserves a missing-model failure once a search runs', async () => {
  makeStubDeps();
  await getRepo().webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'test-key' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: true, upstreamId: 'up_codex', model: 'gpt-missing' },
  } satisfies WebSearchConfig);
  const { AlphaSearchModelNotFoundError } = await vi.importActual<typeof import('../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts')>('../../../../../src/data-plane/tools/web-search/alpha-search/upstream.ts');
  const failure = new AlphaSearchModelNotFoundError();
  mockResolveAlpha.mockClear();
  mockResolveAlpha.mockRejectedValue(failure);
  const inv = makeInvocation({
    targetApi: 'openaiResponses',
    enabledFlags: new Set<FlagId>(['openai-responses-web-search-shim']),
  });
  const script = scriptedRun([
    fcTurn(0, 'call_missing_search_model', SHIM_TOOL_NAME, JSON.stringify({ search_query: [{ q: 'Floway' }] })),
    messageTurn('done', 0),
  ]);
  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);
  const failed = eventPayloads(frames).find(event => event.type === 'response.failed');
  assert(failed !== undefined);
  assertEquals(failed.response.status, 'failed');
  assert(failed.response.error?.message.includes('Search model not found.'));
  assertEquals(failed.response.error?.provider_specific_fields?.name, 'AlphaSearchModelNotFoundError');
  assertEquals(failed.response.error?.provider_specific_fields?.stack, failure.stack);
  assertEquals(script.callCount(), 1);
  assertEquals(mockResolveAlpha.mock.calls.length, 1);
});

test('local and cascaded Floway unsupported commands produce the same agent-visible error', async () => {
  makeStubDeps();
  const commands = { image_query: [{ q: 'Floway logo' }] };
  const expected = 'The configured web search provider does not implement OpenAI search feature `commands.image_query`.';
  const runUnsupported = async (): Promise<string> => {
    const inv = makeInvocation({
      targetApi: 'openaiResponses',
      enabledFlags: new Set<FlagId>(['openai-responses-web-search-shim']),
    });
    const script = scriptedRun([
      fcTurn(0, 'call_unsupported', SHIM_TOOL_NAME, JSON.stringify(commands)),
      messageTurn('model repeated the tool error', 0),
    ]);
    await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);
    return lastFunctionCallOutput(inv.payload.input as CanonicalOpenAIResponsesInputItem[]);
  };

  const localMessage = await runUnsupported();

  await getRepo().webSearchConfig.save({
    provider: 'tavily',
    tavily: { apiKey: 'test-key' },
    microsoftWebIq: { apiKey: '' },
    jina: { apiKey: '' },
    passthroughOpenAiSearch: { enabled: true, upstreamId: 'up_floway', model: 'gpt-search' },
  } satisfies WebSearchConfig);
  mockResolveAlpha.mockResolvedValue(async () => new Response(JSON.stringify({
    error: {
      type: 'internal_error',
      name: 'UnsupportedLocalWebSearchFeatureError',
      message: 'The configured web search provider does not implement OpenAI search feature `commands.image_query`.',
    },
  }), { status: 500, headers: { 'content-type': 'application/json' } }));

  const cascadedMessage = await runUnsupported();
  assertEquals(localMessage, expected);
  assertEquals(cascadedMessage, expected);
});

// ── Forced tool_choice demotes after turn 1 ───────────────────────────

test('tool_choice "required" demotes to "auto" after first intercepted turn', async () => {
  // Without demote: the model is required to call a tool every turn,
  // never produces a terminal message, loops until the iteration cap.
  makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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

test('a forced namespaced client tool choice is not mistaken for the hosted shim function', async () => {
  const { backend } = makeStubDeps();
  const choice = { type: 'function' as const, namespace: 'client', name: SHIM_TOOL_NAME };
  const inv = makeInvocation({
    payload: {
      tool_choice: choice,
      tools: [
        { type: 'web_search' },
        {
          type: 'namespace', name: 'client', description: 'Client tools',
          tools: [{ type: 'function', name: SHIM_TOOL_NAME, parameters: { type: 'object' } }],
        },
      ],
    },
  });
  const seenToolChoices: unknown[] = [];
  const script = scriptedRun([
    fcTurn(0, 'call_search', `${SHIM_TOOL_NAME}_2`, JSON.stringify({ search_query: [{ q: 'q1' }] })),
    messageTurn('done'),
  ]);
  const run = async () => {
    const injected = inv.payload.tools?.[0];
    assert(injected?.type === 'function');
    assertEquals(injected.name, `${SHIM_TOOL_NAME}_2`);
    seenToolChoices.push(inv.payload.tool_choice);
    return await script.run();
  };

  await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), run);

  assertEquals(seenToolChoices, [choice, choice]);
  assertEquals(backend.calls.length, 1);
});

test('max_tool_calls is forwarded to upstream turns but does not locally bypass server tools', async () => {
  const { backend } = makeStubDeps();
  const shim = withOpenAIResponsesWebSearchShim;
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
  const shim = withOpenAIResponsesWebSearchShim;
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
  const drainedSoFar: OpenAIResponsesStreamEventEx[] = [];
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
  const shim = withOpenAIResponsesWebSearchShim;
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
  assertEquals(output.map(o => o.type), ['reasoning', 'web_search_call', 'function_call']);
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
  const shim = withOpenAIResponsesWebSearchShim;
  const inv = makeInvocation();
  const gatewayCtx = mockChatGatewayCtx({
    apiKeyId: 'k1',
    wantsStream: true,
    abortSignal: controller.signal,
  });
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

const mkFunctionCallArgsDelta = (outputIndex: number, delta: string, itemId = `fc_${outputIndex}`): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.function_call_arguments.delta',
    item_id: itemId,
    output_index: outputIndex,
    delta,
  });

const framesOf = (...frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => (async function* () {
  yield* frames;
})();

const eventTypesOf = (frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[]): string[] =>
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
  downstreamFrames: ProtocolFrame<OpenAIResponsesStreamEventEx>[];
  summary: TurnSummary;
  records: DispatchRecord[];
};

const drain = async (
  iter: AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>, TurnSummary>,
  records: DispatchRecord[],
): Promise<DrainResult> => {
  const downstreamFrames: ProtocolFrame<OpenAIResponsesStreamEventEx>[] = [];
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

const consumeTurn = async (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  state: Parameters<typeof consumeTurnStreaming>[1],
  isFirstTurn: boolean,
): Promise<DrainResult> => {
  const records: DispatchRecord[] = [];
  return await drain(
    consumeTurnStreaming(frames, state, isFirstTurn, new Map([[SHIM_TOOL_NAME, recordingDispatcher(records)]]), loopState(), []),
    records,
  );
};

test('consumeTurn uses the completed call namespace before executing a hosted tool', async () => {
  const completed = {
    type: 'function_call' as const,
    id: 'fc_client', call_id: 'call_client', namespace: 'client', name: SHIM_TOOL_NAME,
    arguments: '{"client":true}', status: 'completed',
  };
  const result = await consumeTurn(framesOf(
    mkResponseCreated(),
    eventFrame<OpenAIResponsesStreamEventEx>({
      type: 'response.output_item.added', output_index: 0,
      item: { ...completed, namespace: undefined, arguments: '', status: 'in_progress' },
    }),
    mkFunctionCallArgsDelta(0, completed.arguments, completed.id),
    mkFunctionCallArgsDone(0, completed.arguments, completed.id),
    eventFrame<OpenAIResponsesStreamEventEx>({ type: 'response.output_item.done', output_index: 0, item: completed }),
    mkResponseCompleted(),
  ), createMergeState(), true);

  assertEquals(result.records, []);
  assertEquals(result.summary.dispatchedSlots, []);
  assertFalse(result.summary.sawServerToolCall);
  assertEquals(result.summary.sawClientToolCall, true);
  assertEquals(outputItemDoneEvents(result.downstreamFrames).map(event => event.item), [completed]);
  assertEquals(eventTypesOf(result.downstreamFrames).filter(type => type.startsWith('response.function_call_arguments.')), [
    'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  ]);
});

test('consumeTurn forwards queued only from the first upstream turn', async () => {
  const firstState = createMergeState();
  const first = await consumeTurn(
    framesOf(mkResponseQueued('queued_first'), mkResponseCreated('created_first'), mkResponseCompleted()),
    firstState,
    true,
  );
  assertEquals(eventTypesOf(first.downstreamFrames), ['response.queued', 'response.created']);
  const queued = first.downstreamFrames[0];
  assert(queued.type === 'event' && queued.event.type === 'response.queued');
  assertEquals(queued.event.response.id, firstState.synthesizedResponseId);
  assertEquals(queued.event.response.status, 'queued');

  const later = await consumeTurn(
    framesOf(mkResponseQueued('queued_later'), mkResponseCreated('created_later'), mkResponseCompleted()),
    createMergeState(),
    false,
  );
  assertEquals(later.downstreamFrames, []);
});

test('consumeTurn forwards content_part / output_text / annotation events live with rewritten item_id', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkResponseInProgress(),
      mkMessageAdded(0),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.content_part.added',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_text.delta',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        delta: 'hello ',
      }),
      eventFrame<OpenAIResponsesStreamEventEx>({
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
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.output_text.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        text: 'hello world',
      }),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.content_part.done',
        item_id: 'msg_upstream',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: 'hello world', annotations: [] },
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

  const addedFrame = result.downstreamFrames.find(frame =>
    frame.type === 'event' && frame.event.type === 'response.output_item.added');
  assert(addedFrame?.type === 'event');
  const messageId = (addedFrame.event as { item: { id?: string } }).item.id;
  assert(messageId !== undefined && /^msg_[0-9a-f]{32}$/.test(messageId));

  for (const f of result.downstreamFrames) {
    if (f.type !== 'event') continue;
    const ev = f.event as { item_id?: string };
    if (ev.item_id !== undefined) {
      assertEquals(ev.item_id, messageId);
    }
  }
});

test('consumeTurn swallows future indexed events attached to an intercepted server tool call', async () => {
  const state = createMergeState();
  const result = await consumeTurn(
    framesOf(
      mkResponseCreated(),
      mkFunctionCallAdded(0, 'cc_1', SHIM_TOOL_NAME),
      eventFrame<OpenAIResponsesStreamEventEx>({
        type: 'response.future_function_call_arguments.delta',
        item_id: 'fc_hidden',
        output_index: 0,
        delta: 'hidden',
      } as unknown as OpenAIResponsesStreamEventEx),
      mkFunctionCallDone(0, 'cc_1', SHIM_TOOL_NAME, '{"search_query":[{"q":"q"}]}'),
      mkResponseCompleted(),
    ),
    state,
    true,
  );

  assertFalse(result.downstreamFrames.some(f =>
    f.type === 'event' && (f.event as { type: string }).type === 'response.future_function_call_arguments.delta'));
});

// ── Echo restore on `response.tools` / `response.tool_choice` ─────────────
//
// The shim rewrites the request's hosted `web_search` to a function tool
// before upstream; on echo (per OpenAI spec, `Response` composes
// `ResponseProperties`, so `tools` and `tool_choice` are echoed) the
// synthesized envelope must restore the canonical hosted form so the
// client never sees the gateway-internal function tool name.

const mkResponseCreatedWithTools = (
  tools: OpenAIResponsesTool[],
  toolChoice?: OpenAIResponsesToolChoice,
): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame({
    type: 'response.created',
    response: {
      ...emptyResult('upstream_test', 'in_progress'),
      tools,
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    },
  });

const mkResponseCompletedWithTools = (
  tools: OpenAIResponsesTool[],
  toolChoice?: OpenAIResponsesToolChoice,
): ProtocolFrame<OpenAIResponsesStreamEventEx> =>
  eventFrame<OpenAIResponsesStreamEventEx>({
    type: 'response.completed',
    response: {
      ...emptyResult('upstream_test', 'completed'),
      tools,
      ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    },
  });

const findResponseCompleted = (
  frames: ProtocolFrame<OpenAIResponsesStreamEventEx>[],
): Extract<OpenAIResponsesStreamEventEx, { type: 'response.completed' }> => {
  for (const f of frames) {
    if (f.type === 'event' && f.event.type === 'response.completed') {
      return f.event;
    }
  }
  throw new Error('no response.completed in downstream frames');
};

test('duplicate hosted web_search declarations collapse to the last complete declaration', async () => {
  makeStubDeps();
  const firstFilters = { allowed_domains: ['first.example'] };
  const lastFilters = { allowed_domains: ['last.example'] };
  const inv = makeInvocation({
    payload: {
      tools: [
        { type: 'web_search', search_context_size: 'high', filters: firstFilters },
        { type: 'web_search_preview', search_context_size: 'low', filters: lastFilters },
      ],
    },
  });
  // Upstream sees exactly one function tool because the framework
  // dedupes before run().
  const upstreamEchoedTools: OpenAIResponsesTool[] = [
    { type: 'function', name: SHIM_TOOL_NAME, parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: false },
  ];
  const script = scriptedRun([[
    mkResponseCreatedWithTools(upstreamEchoedTools),
    mkResponseInProgress(),
    mkMessageAdded(0),
    mkMessageDone(0, 'done'),
    mkResponseCompletedWithTools(upstreamEchoedTools),
  ]]);

  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), script.run);

  // Request side: only one function tool was sent upstream.
  assertEquals(inv.payload.tools?.length, 1);
  assertEquals(inv.payload.tools?.[0].type, 'function');
  // Response side: one restored declaration with the last alias and all of
  // its configuration.
  const completed = findResponseCompleted(frames);
  assertEquals(completed.response.tools!.length, 1);
  assertEquals(completed.response.tools![0].type, 'web_search_preview');
  assertEquals((completed.response.tools![0] as { search_context_size: string }).search_context_size, 'low');
  assertEquals((completed.response.tools![0] as { filters: typeof lastFilters }).filters, lastFilters);
});

test('the shim drains continuation streams before awaiting billable metadata', async () => {
  const { backend } = makeStubDeps();
  const turns = [searchCallTurn(0, 'first', 'first search'), searchCallTurn(0, 'second', 'second search'), messageTurn('done')];
  let runCalls = 0;
  const result = await withOpenAIResponsesWebSearchShim(makeInvocation(), makeGatewayCtx(), async () => {
    const frames = turns[runCalls++];
    const billableUsage: BillableUsage = { input: runCalls, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: runCalls };
    let resolveFinal!: (metadata: { modelIdentity: typeof testTelemetryModelIdentity; billableUsage: BillableUsage }) => void;
    const finalMetadata = new Promise<{ modelIdentity: typeof testTelemetryModelIdentity; billableUsage: BillableUsage }>(resolve => { resolveFinal = resolve; });
    return eventResult((async function* () {
      for (const frame of frames) yield frame;
      resolveFinal({ modelIdentity: testTelemetryModelIdentity, billableUsage });
    })(), testTelemetryModelIdentity, { finalMetadata });
  });

  assert(result.type === 'events');
  const frames = await collectFrames(result.events);
  assertEquals(findResponseCompleted(frames).response.status, 'completed');
  assertEquals(runCalls, 3);
  assertEquals(backend.calls.length, 2);
  assertEquals((await result.finalMetadata!).billableUsage, { input: 6, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 6 });
}, 1_000);

test('the shim retains observed billing when a later turn throws after its usage', async () => {
  makeStubDeps();
  let runCalls = 0;
  const streamError = new Error('stream interrupted after usage');
  const result = await withOpenAIResponsesWebSearchShim(makeInvocation(), makeGatewayCtx(), async () => {
    const fails = ++runCalls === 2;
    let resolveFinal!: (metadata: { modelIdentity: typeof testTelemetryModelIdentity; billableUsage: BillableUsage }) => void;
    const finalMetadata = new Promise<{ modelIdentity: typeof testTelemetryModelIdentity; billableUsage: BillableUsage }>(resolve => { resolveFinal = resolve; });
    const billableUsage: BillableUsage = { input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 2 };
    return eventResult((async function* () {
      try {
        const frames = fails ? [mkResponseCreated(), mkResponseCompleted()] : searchCallTurn(0, 'first', 'first search');
        for (const frame of frames) yield frame;
        if (fails) throw streamError;
      } finally {
        resolveFinal({ modelIdentity: testTelemetryModelIdentity, billableUsage });
      }
    })(), testTelemetryModelIdentity, { finalMetadata });
  });

  assert(result.type === 'events');
  const frames = await collectFrames(result.events);
  const failed = eventPayloads(frames).find(event => event.type === 'response.failed');
  assert(failed?.type === 'response.failed');
  assertEquals(failed.response.error?.message, `Upstream stream failed mid-response: ${streamError.message}`);
  assertEquals(runCalls, 2);
  assertEquals((await result.finalMetadata!).billableUsage, { input: 20, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 4 });
}, 1_000);

test('helper allocation reserves names across callable scopes, history and search-loaded tools without moving declarations', () => {
  const tools: OpenAIResponsesTool[] = [
    { type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'web_search' }] },
    { type: 'namespace', name: 'client', description: '', tools: [{ type: 'custom', name: 'web_search_2' }] },
    { type: 'function', name: 'web_search_3' },
    { type: 'web_search', name: 'web_search_8' },
  ];
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'function_call', namespace: 'history', name: 'web_search_4', call_id: 'old', arguments: '{}', status: 'completed' },
    { type: 'tool_search_output', tools: [{ type: 'namespace', name: 'loaded', description: '', tools: [{ type: 'function', name: 'web_search_5' }] }] },
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'custom', name: 'web_search_6' }] },
  ];
  const original = structuredClone({ tools, input });
  assertEquals(resolveServerToolName('web_search', tools, input, { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'web_search_7', namespace: 'client' }] }), 'web_search_8');
  assertEquals(resolveServerToolName('web_search', [], [], { type: 'custom', name: 'web_search' }), 'web_search_2');
  assertEquals({ tools, input }, original);
});

test('hosted dispatch refuses a closing call whose identity changed', async () => {
  const records: DispatchRecord[] = [];
  const iter = consumeTurnStreaming(framesOf(
    mkResponseCreated(),
    eventFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: SHIM_TOOL_NAME, id: 'item', call_id: 'call', arguments: '', status: 'in_progress' } }),
    eventFrame({ type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', name: 'other', id: 'item', call_id: 'call', arguments: '{}', status: 'completed' } }),
    mkResponseCompleted(),
  ), createMergeState(), true, new Map([[SHIM_TOOL_NAME, recordingDispatcher(records)]]), loopState(), []);
  await assertRejects(() => drain(iter, records), Error, 'changed a server-tool function identity');
  assertEquals(records, []);
});

for (const targetApi of ['openaiChatCompletions', 'openaiResponses'] as const) {
  test(`namespace client calls remain client-owned through the ${targetApi} helper boundary`, async () => {
    const { backend } = makeStubDeps();
    const inv = makeInvocation({
      targetApi, enabledFlags: new Set(['openai-responses-web-search-shim']), payload: {
        tools: [{ type: 'web_search' }, { type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: SHIM_TOOL_NAME, parameters: { type: 'object' } }] }],
      },
    });
    const ctx = makeGatewayCtx();
    let turns = 0;
    const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, ctx, async () => {
      turns++;
      assertEquals(inv.payload.tools?.[0], { ...inv.payload.tools?.[0], name: `${SHIM_TOOL_NAME}_2` });
      if (targetApi === 'openaiResponses') {
        const item = { type: 'function_call' as const, name: SHIM_TOOL_NAME, namespace: 'functions', call_id: 'client', arguments: '{}', status: 'completed' as const };
        return await scriptedRun([[
          mkResponseCreated(),
          eventFrame({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } }),
          eventFrame({ type: 'response.output_item.done', output_index: 0, item }),
          mkResponseCompleted(),
        ]]).run();
      }
      const trip = await routeOpenAIResponsesViaOpenAIChatCompletions(inv.payload, { sidecarCodec: mockChatGatewayCtx().sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) });
      if (trip.type === 'input-error') return inputErrorResult(trip);
      const client = trip.target.tools?.[1];
      assert(client?.type === 'function');
      const events = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
        yield eventFrame({ id: 'chat', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{  index: 0, delta: { tool_calls: [{ index: 0, id: 'client', type: 'function', function: { name: client.function.name, arguments: '{}' } }] }, finish_reason: null }] });
        yield eventFrame({ id: 'chat', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{  index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      })();
      return eventResult(trip.events(events), testTelemetryModelIdentity);
    });
    assertEquals(turns, 1);
    assertEquals(backend.calls, []);
    assertEquals(findResponseCompleted(frames).response.output.map(item => item.type === 'function_call' ? [item.type, item.name, item.namespace] : [item.type]), [['function_call', SHIM_TOOL_NAME, 'functions'], ...(targetApi === 'openaiResponses' ? [] : [['reasoning']])]);
  });
}

for (const [target, mode] of [
  ['openaiChatCompletions', 'forced'],
  ['anthropicMessages', 'auto'],
  ['anthropicMessages', 'required'],
] as const) {
  test(`${target} ${mode} helper choice follows a namespace-induced alias and preserves translation constraints`, async () => {
    const { backend } = makeStubDeps();
    const selector = { type: 'function' as const, name: SHIM_TOOL_NAME };
    const choice: OpenAIResponsesToolChoice = mode === 'forced' ? selector : { type: 'allowed_tools', mode, tools: [selector] };
    const original = structuredClone(choice);
    const inv = makeInvocation({
      targetApi: target,
      payload: {
        tools: [{ type: 'web_search' }, { type: 'namespace', name: 'client', description: '', tools: [{ type: 'function', name: SHIM_TOOL_NAME }] }],
        tool_choice: choice,
      },
    });
    const alias = `${SHIM_TOOL_NAME}_2`;
    const script = scriptedRun([fcTurn(0, 'hosted', alias, '{"search_query":[{"q":"hosted"}]}'), messageTurn('done')]);
    const choices: unknown[] = [];
    const run = async () => {
      choices.push(structuredClone(inv.payload.tool_choice));
      const before = structuredClone(inv.payload);
      const trip = target === 'openaiChatCompletions'
        ? await routeOpenAIResponsesViaOpenAIChatCompletions(inv.payload, { sidecarCodec: mockChatGatewayCtx().sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) })
        : await routeOpenAIResponsesViaAnthropicMessages(inv.payload, { sidecarCodec: mockChatGatewayCtx().sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) });
      if (trip.type === 'input-error') return inputErrorResult(trip);
      const wire = JSON.parse(JSON.stringify(trip.target)) as { tools: Array<{ name?: string; function?: { name: string } }> };
      assert(wire.tools.some(tool => (tool.function?.name ?? tool.name) === alias), 'the complete declaration list must retain the helper alias');
      assertEquals(inv.payload, before, 'repeated translation must preserve the outer loop payload');
      return await script.run();
    };
    if (target === 'anthropicMessages' && mode === 'auto') {
      const { result } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), run);
      assert(result.type === 'api-error');
      assertEquals(result.status, 400);
      assert(new TextDecoder().decode(result.body).includes('allowed_tools auto subset'));
      assertEquals(script.callCount(), 0);
      assertEquals(backend.calls.length, 0);
      assertEquals(choices, [{ type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: alias }] }]);
      return;
    }
    const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), run);
    const renamed = { type: 'function', name: alias };
    assertEquals(choices, mode === 'forced' ? [renamed, 'auto'] : [
      { type: 'allowed_tools', mode, tools: [renamed] },
      { type: 'allowed_tools', mode: 'auto', tools: [renamed] },
    ]);
    assertEquals(choice, original);
    assertEquals(backend.calls.length, 1);
    if (target === 'anthropicMessages' && mode === 'required') {
      assertEquals(script.callCount(), 1);
      const error = frames.find(frame => frame.type === 'event' && frame.event.type === 'error');
      expect(error).toMatchObject({ event: { type: 'error', error: { message: expect.stringContaining('allowed_tools auto subset'), code: null } } });
      const failed = frames.find(frame => frame.type === 'event' && frame.event.type === 'response.failed');
      expect(failed).toMatchObject({ event: { response: { status: 'failed', error: null } } });
      return;
    }
    assertEquals(script.callCount(), 2);
    assertEquals(findResponseCompleted(frames).response.tool_choice, original);
  });
}

test('a forced helper alias never captures an unqualified client function from history', async () => {
  const { backend } = makeStubDeps();
  const tools: OpenAIResponsesTool[] = [
    { type: 'web_search' },
    { type: 'namespace', name: 'client', description: '', tools: [{ type: 'function', name: SHIM_TOOL_NAME }] },
  ];
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'message', role: 'user', content: 'Continue.' },
    { type: 'function_call', name: SHIM_TOOL_NAME, call_id: 'past', arguments: '{}', status: 'completed' },
  ];
  const choice: OpenAIResponsesToolChoice = { type: 'function', name: SHIM_TOOL_NAME };
  const inv = makeInvocation({ payload: { tools, input, tool_choice: choice } });
  const script = scriptedRun([fcTurn(0, 'client', SHIM_TOOL_NAME, '{}')]);
  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), async () => {
    assertEquals(inv.payload.tool_choice, choice);
    const helper = inv.payload.tools?.[0];
    assert(helper?.type === 'function');
    assertEquals(helper.name, `${SHIM_TOOL_NAME}_2`);
    return await script.run();
  });
  assertEquals(script.callCount(), 1);
  assertEquals(backend.calls, []);
  assertEquals(findResponseCompleted(frames).response.status, 'completed');
});

test('required allowed_tools demotes only its mode after hosted execution', async () => {
  const { backend } = makeStubDeps();
  const choice: OpenAIResponsesToolChoice = {
    type: 'allowed_tools', mode: 'required', tools: [
      { type: 'web_search' },
      { type: 'function', name: 'client_allowed' },
    ],
  };
  const original = structuredClone(choice);
  const inv = makeInvocation({ payload: { tools: [{ type: 'web_search' }, { type: 'function', name: 'client_allowed' }, { type: 'function', name: 'excluded' }], tool_choice: choice } });
  const script = scriptedRun([searchCallTurn(0, 'hosted', 'query'), messageTurn('done')]);
  const choices: unknown[] = [];
  const declarations: Array<CanonicalOpenAIResponsesPayload['tools']> = [];
  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), async () => {
    choices.push(inv.payload.tool_choice);
    declarations.push(inv.payload.tools);
    return await script.run();
  });
  const allowed = [{ type: 'function', name: SHIM_TOOL_NAME }, { type: 'function', name: 'client_allowed' }];
  assertEquals(choices, [{ type: 'allowed_tools', mode: 'required', tools: allowed }, { type: 'allowed_tools', mode: 'auto', tools: allowed }]);
  assertEquals(declarations[0]?.map(tool => 'name' in tool ? tool.name : undefined), [SHIM_TOOL_NAME, 'client_allowed', 'excluded']);
  assert(declarations[0] === declarations[1], 'mode demotion must retain the same declaration inventory');
  assertEquals(script.callCount(), 2);
  assertEquals(backend.calls.length, 1);
  assertEquals(choice, original);
  assertEquals(findResponseCompleted(frames).response.tool_choice, original);
});

test('helper echoes distinguish namespaced functions and rewrite hosted allowed_tools selectors reversibly', async () => {
  makeStubDeps();
  const choice: OpenAIResponsesToolChoice = { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] };
  const inv = makeInvocation({ payload: { tool_choice: structuredClone(choice) } });
  const qualified = { type: 'function' as const, name: SHIM_TOOL_NAME, namespace: 'client' };
  const { frames } = await runShimAndDrain(withOpenAIResponsesWebSearchShim, inv, makeGatewayCtx(), async () => {
    assertEquals(inv.payload.tool_choice, { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: SHIM_TOOL_NAME }] });
    return await scriptedRun([[
      mkResponseCreated(),
      eventFrame({ type: 'response.completed', response: { ...emptyResult('upstream', 'completed'), tools: [qualified, { type: 'function', name: SHIM_TOOL_NAME }], tool_choice: inv.payload.tool_choice } }),
    ]]).run();
  });
  const tools = findResponseCompleted(frames).response.tools;
  assertEquals(tools?.length, 2);
  assertEquals(tools?.[0], qualified);
  assertEquals(tools?.[1].type, 'web_search');
  assertEquals(findResponseCompleted(frames).response.tool_choice, choice);
});

test('server-tool loop preserves internal failure diagnostics on the failed resource', async () => {
  makeStubDeps();
  const cause = { operation: 'translated upstream dispatch' };
  const failure = { type: 'internal_error' as const, name: 'TypeError', message: 'Cannot translate tool input', stack: 'TypeError: Cannot translate tool input', cause, target_api: 'anthropicMessages' };
  let runCalls = 0;
  const run = async (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> => {
    runCalls += 1;
    if (runCalls === 1) return { type: 'events', events: framesOf(...searchCallTurn(0, 'call_1', 'q1')), modelIdentity: testTelemetryModelIdentity };
    return { type: 'internal-error', status: 502, error: failure };
  };
  const result = await withOpenAIResponsesWebSearchShim(makeInvocation(), makeGatewayCtx(), run);
  assert(result.type === 'events');
  const events = eventPayloads(await collectFrames(result.events));
  const terminal = events.at(-1);
  assert(terminal?.type === 'response.failed');
  assertEquals(runCalls, 2);
  assertEquals(terminal.response.error?.code, 'server_error');
  assertEquals(terminal.response.error?.message, failure.message);
  assertEquals(terminal.response.error?.provider_specific_fields, { name: failure.name, stack: failure.stack, cause, target_api: failure.target_api });
  assert(terminal.response.error?.provider_specific_fields?.cause === cause);
  assertFalse('stack' in (terminal.response.error as object));
});
