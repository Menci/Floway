import { afterEach, test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from './test-policy.ts';
import { createOpenAIResponsesHttpStore, MemoryStatefulOpenAIResponsesBacking, LayeredStatefulOpenAIResponsesStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { StoredOpenAIResponsesItem, StoredOpenAIResponsesSnapshot } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { type ModelCandidate, directFetcher, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

// Mock the resolver seam so each test hands the serve exactly the provider
// candidates it wants, optionally with an alias-rules overlay attached.
// `sawModel` defaults to true when at least one candidate was queued; the
// `model-missing` failure tests queue an empty list and expect `sawModel:
// false` so the serve renders 404 rather than 400.
interface QueuedResolution {
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}
const resolutionsQueue: QueuedResolution[] = [];
const lastResolveCall: { model?: string } = {};
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async ({ model }: { model: string }) => {
      lastResolveCall.model = model;
      const next = resolutionsQueue.shift();
      if (next === undefined) throw new Error('serve_test: no resolution enqueued');
      return next;
    }),
  };
});

const { openaiResponsesServe } = await import('../../../../src/data-plane/chat/openai-responses/serve.ts');
const { expandPreviousResponseId } = await import('../../../../src/data-plane/chat/openai-responses/serve-prep.ts');

const API_KEY_ID = 'key_serve_test';

const queueResolution = (
  candidates: readonly ModelCandidate[],
  extra: { sawModel?: boolean; aliasRules?: AliasRules } = {},
): void => {
  const rules = extra.aliasRules;
  resolutionsQueue.push({
    candidates: rules !== undefined ? candidates.map(c => ({ ...c, rules })) : candidates,
    sawModel: extra.sawModel ?? candidates.length > 0,
    failedUpstreams: [],
  });
};

afterEach(() => { resolutionsQueue.length = 0; });

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: API_KEY_ID, userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  return repo;
};

const makeGatewayCtx = (store?: ChatGatewayCtx['store']) =>
  mockChatGatewayCtx({
    apiKeyId: API_KEY_ID,
    wantsStream: true,
    store: store ?? createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true),
  });

const makePayload = (overrides: Partial<CanonicalOpenAIResponsesPayload> = {}): CanonicalOpenAIResponsesPayload => ({
  model: 'test-model',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});

// Compact tests need a real input array (a bare string can't carry the
// compaction trigger or item_reference shapes the routing layer cares
// about). Default to the kept-user-message the existing happy-path test
// uses; override `input` when a test needs a different shape.
const compactPayload = (overrides: Partial<CanonicalOpenAIResponsesPayload> = {}): CanonicalOpenAIResponsesPayload =>
  makePayload({ input: [{ type: 'message', role: 'user', content: 'kept' }], ...overrides });

const makeOpenAIResponsesResult = (id = 'resp_test'): OpenAIResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  status: 'completed',
  output: [{
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
  }],
  output_text: 'hi',
  error: null,
  incomplete_details: null,
});

const makeProtocolFrames = async function* <E>(events: readonly E[]): AsyncGenerator<ProtocolFrame<E>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  modelId?: string;
  endpoints?: ModelEndpoints;
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>>;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callOpenAIResponses: overrides.callOpenAIResponses,
    callAnthropicMessages: overrides.callAnthropicMessages,
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
  });
  return {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: provider,
    },
    // Default keeps stubInternalModel's three-endpoint map intact; tests that
    // need a rejected candidate pass an explicit `endpoints` override.
    model: stubInternalModel({
      id: overrides.modelId ?? 'test-model',
      ...(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
    }, upstream),
    fetcher: directFetcher,
  };
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): Promise<OpenAIResponsesStreamEvent[]> => {
  const out: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('generate routes a native OpenAI Responses candidate end to end', async () => {
  installRepo();
  const completed: OpenAIResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeOpenAIResponsesResult(),
  };
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProtocolFrames([completed]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_a', callOpenAIResponses });
  queueResolution([candidate]);

  const result = await openaiResponsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  const events = await collectEvents(result.events);
  assert(events.length >= 1);
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test('compact returns a result envelope from the wrapped attempt', async () => {
  installRepo();
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: OpenAIResponsesResult = {
    ...makeOpenAIResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as OpenAIResponsesResult['output'],
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
  };
  const observedModelIds: string[] = [];
  const callOpenAIResponses = vi.fn(async (model: unknown, _body: unknown, action: OpenAIResponsesAction): Promise<ProviderOpenAIResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    observedModelIds.push((model as { id: string }).id);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });
  const candidate = makeCandidate({ upstream: 'up_a', modelId: 'gpt-target', callOpenAIResponses });
  queueResolution([candidate]);
  const payload = compactPayload({ model: 'gpt-alias' });

  const result = await openaiResponsesServe.compact({
    payload,
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
  assertEquals(callOpenAIResponses.mock.calls[0][2], 'compact');
  assertEquals(observedModelIds, ['gpt-target']);
  assertEquals(payload.model, 'gpt-alias');
});

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
  installRepo();
  const originalImageUrl = 'data:image/png;base64,AQID';
  const payload = makePayload({
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: originalImageUrl, detail: 'auto' }],
    }],
  });
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderOpenAIResponsesResult> => {
    const item = (body as Omit<CanonicalOpenAIResponsesPayload, 'model'>).input[0];
    if (item.type !== 'message' || !Array.isArray(item.content) || item.content[0]?.type !== 'input_image') throw new Error('expected image content');
    item.content[0].image_url = 'data:image/webp;base64,COMPRESSED';
    return { action: 'generate', ok: false, response: firstError, modelKey: 'first-key' };
  });
  const completed: OpenAIResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeOpenAIResponsesResult('resp_second'),
  };
  let fallbackImageUrl: string | null | undefined;
  const secondCall = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderOpenAIResponsesResult> => {
    const item = (body as Omit<CanonicalOpenAIResponsesPayload, 'model'>).input[0];
    if (item.type !== 'message' || !Array.isArray(item.content) || item.content[0]?.type !== 'input_image') throw new Error('expected image content');
    fallbackImageUrl = item.content[0].image_url;
    return { action: 'generate', ok: true, events: makeProtocolFrames([completed]), modelKey: 'second-key', headers: new Headers() };
  });
  const first = makeCandidate({ upstream: 'up_a', callOpenAIResponses: firstCall });
  const second = makeCandidate({ upstream: 'up_b', callOpenAIResponses: secondCall });
  queueResolution([first, second]);

  const result = await openaiResponsesServe.generate({
    payload,
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  // The narrowed candidate list exists exactly so a transient upstream
  // failure (5xx/429/network) on one entry rolls over to the next. The
  // second candidate's success is the request's final answer.
  assertEquals(result.type, 'events');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 1);
  assertEquals(fallbackImageUrl, originalImageUrl);
  const sourceItem = payload.input[0];
  if (sourceItem.type !== 'message' || !Array.isArray(sourceItem.content) || sourceItem.content[0]?.type !== 'input_image') throw new Error('expected source image content');
  assertEquals(sourceItem.content[0].image_url, originalImageUrl);
});

// A mid-attempt throw (interceptor bug / translation error / provider-layer
// JS exception not represented as a ChatServeFailure) must attribute the perf
// error row to the throwing candidate, not the previous one that already
// failed cleanly with a 5xx.
test('mid-attempt throw stamps telemetry with the throwing candidate, not the previous one', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: false, response: firstError, modelKey: 'first-key',
  }));
  const secondCall = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => {
    throw new Error('simulated provider-layer JS exception');
  });
  queueResolution([
    makeCandidate({ upstream: 'up_a', callOpenAIResponses: firstCall }),
    makeCandidate({ upstream: 'up_b', callOpenAIResponses: secondCall }),
  ]);

  const ctx = makeGatewayCtx();
  await openaiResponsesServe.generate({
    payload: makePayload(),
    ctx,
    headers: new Headers(),
  }).then(
    () => { throw new Error('expected openaiResponsesServe.generate to throw'); },
    (error: unknown) => {
      assertEquals((error as Error).message, 'simulated provider-layer JS exception');
    },
  );

  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 1);
  assertEquals(ctx.attempt.telemetry?.upstream, 'up_b');
});

test('generate renders model-missing when no candidates are available', async () => {
  installRepo();
  queueResolution([]);

  const result = await openaiResponsesServe.generate({
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

test('generate filters out candidates whose endpoints do not satisfy the responses preference and renders model-unsupported as a 400', async () => {
  installRepo();
  const callOpenAIResponses = vi.fn();
  // openaiResponsesTarget prefers responses > messages > openai-chat-completions; an
  // endpoints-only `openaiCompletions` candidate matches none and is filtered out.
  queueResolution([makeCandidate({ upstream: 'up_x', endpoints: { openaiCompletions: {} }, callOpenAIResponses })]);

  const result = await openaiResponsesServe.generate({
    payload: makePayload({ model: 'wrong-endpoint-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callOpenAIResponses.mock.calls.length, 0);
});

test('compact renders model-missing as a 404 when no candidates are available', async () => {
  installRepo();
  queueResolution([]);

  const result = await openaiResponsesServe.compact({
    payload: compactPayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('not available'));
});

test('compact renders model-unsupported as a 400 when the only candidate\'s endpoints don\'t satisfy responses target preferences', async () => {
  installRepo();
  const callOpenAIResponses = vi.fn();
  // openaiResponsesTarget prefers responses > messages > openai-chat-completions; an
  // endpoints-only `openaiCompletions` candidate matches none and is filtered out.
  queueResolution([makeCandidate({ upstream: 'up_x', endpoints: { openaiCompletions: {} }, callOpenAIResponses })]);

  const result = await openaiResponsesServe.compact({
    payload: compactPayload({ model: 'wrong-endpoint-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callOpenAIResponses.mock.calls.length, 0);
});

test('expandPreviousResponseId prepends snapshot items and strips the previous_response_id field', async () => {
  const repo = installRepo();
  const previousMessageId = 'msg_previous';
  await repo.openaiResponsesItems.insertMany([{
    id: previousMessageId,
    apiKeyId: API_KEY_ID,
    itemHash: 'previous-message-hash',
    payload: { item: { type: 'message', id: previousMessageId, role: 'user', content: 'first turn' } },
    refreshedAt: Date.now(),
  }], 0);
  const snapshot: StoredOpenAIResponsesSnapshot = {
    id: 'resp_prev',
    apiKeyId: API_KEY_ID,
    itemIds: [previousMessageId],
    refreshedAt: Date.now(),
  };
  await repo.openaiResponsesSnapshots.insert(snapshot);

  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const expanded = await expandPreviousResponseId(
    makePayload({
      previous_response_id: 'resp_prev',
      input: [{ type: 'message', role: 'user', content: 'second turn' }],
    }),
    store,
  );

  assertEquals(expanded.previous_response_id, undefined);
  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id: previousMessageId });
  assertEquals(expanded.input[1], { type: 'message', role: 'user', content: 'second turn' });
});

// In-memory store backed by the layered implementation but with no repo
// behind it, so an `expandPreviousResponseId` test can sit on a snapshot
// that lives nowhere else.
const memoryStore = async (snapshots: readonly StoredOpenAIResponsesSnapshot[], items: readonly StoredOpenAIResponsesItem[]) => {
  const backing = new MemoryStatefulOpenAIResponsesBacking();
  for (const item of items) await backing.insertItems([item]);
  for (const snapshot of snapshots) await backing.insertSnapshot(snapshot);
  return new LayeredStatefulOpenAIResponsesStore({
    apiKeyId: API_KEY_ID,
    reads: [backing],
    writes: [backing],
  });
};

test('expandPreviousResponseId resolves snapshots from a non-repo-backed store', async () => {
  installRepo(); // affinity lookups in the wider flow still need a repo, but here the helper only touches the store.
  const id = 'msg_memory';
  const item: StoredOpenAIResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    itemHash: 'memory-message-hash',
    payload: { item: { type: 'message', id, role: 'user', content: 'remembered' } },
    refreshedAt: 1_000,
  };
  const snapshot: StoredOpenAIResponsesSnapshot = {
    id: 'resp_mem',
    apiKeyId: API_KEY_ID,
    itemIds: [id],
    refreshedAt: 1_000,
  };
  const store = await memoryStore([snapshot], [item]);

  const expanded = await expandPreviousResponseId(
    makePayload({ previous_response_id: 'resp_mem', input: [{ type: 'message', role: 'user', content: 'new turn' }] }),
    store,
  );

  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id });
});

test('generate falls through translate-out to messages target', async () => {
  installRepo();
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      {
        type: 'message_start',
        message: {
          id: 'msg_translated',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]),
    modelKey: 'messages-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_m', endpoints: { anthropicMessages: {} }, callAnthropicMessages });
  queueResolution([candidate]);

  const result = await openaiResponsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
});

test('Anthropic Messages biology refusal becomes a non-retryable Codex OpenAI Responses policy failure', async () => {
  installRepo();
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      {
        type: 'message_start',
        message: {
          id: 'msg_bio_refusal',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-fable-5',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'refusal',
          stop_details: {
            type: 'refusal',
            category: 'bio',
            explanation: 'This request could enable biological harm.',
          },
          stop_sequence: null,
        },
        usage: { output_tokens: 0 },
      },
      { type: 'message_stop' },
    ]),
    modelKey: 'messages-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_m', endpoints: { anthropicMessages: {} }, callAnthropicMessages });
  queueResolution([candidate]);

  const result = await openaiResponsesServe.generate({ payload: makePayload(), ctx: makeGatewayCtx(), headers: new Headers() });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  const events = await collectEvents(result.events);
  const failed = events.find((event): event is Extract<OpenAIResponsesStreamEvent, { type: 'response.failed' }> => event.type === 'response.failed');

  assertEquals(failed?.response.status, 'failed');
  assertEquals(failed?.response.error, {
    code: 'bio_policy',
    message: 'This content was flagged for possible biological risk. This request could enable biological harm.',
  });
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
});

test('generate falls through translate-out to openai-chat-completions target', async () => {
  installRepo();
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]),
    modelKey: 'chat-completions-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_c', endpoints: { openaiChatCompletions: {} }, callOpenAIChatCompletions });
  queueResolution([candidate]);

  const result = await openaiResponsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 1);
});

test('alias resolution swaps the inbound model id for the target and overlays rules onto the OpenAI Responses IR', async () => {
  installRepo();
  const capturedBodies: OpenAIResponsesPayload[] = [];
  const observedModelIds: string[] = [];
  const callOpenAIResponses = vi.fn(async (model: unknown, body: unknown): Promise<ProviderOpenAIResponsesResult> => {
    observedModelIds.push((model as { id: string }).id);
    capturedBodies.push(body as OpenAIResponsesPayload);
    return { action: 'generate', ok: true, events: makeProtocolFrames([{ type: 'response.completed', sequence_number: 0, response: makeOpenAIResponsesResult() }]), modelKey: 'gpt-5.4', headers: new Headers() };
  });
  const candidate = makeCandidate({ upstream: 'up_a', modelId: 'gpt-5.4', callOpenAIResponses });
  queueResolution([candidate], {
    aliasRules: { reasoning: { effort: 'high', summary: 'detailed' }, verbosity: 'medium', serviceTier: 'priority' },
  });

  const payload = makePayload({ model: 'gpt-fast' });
  const result = await openaiResponsesServe.generate({
    payload,
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  // Resolver and caller payload retain the inbound alias; the provider model
  // argument carries the resolved target id while the body omits `model`.
  assertEquals(lastResolveCall.model, 'gpt-fast');
  assertEquals(observedModelIds, ['gpt-5.4']);
  assertEquals(payload.model, 'gpt-fast');
  const observed = capturedBodies[0]!;
  assertEquals(observed.reasoning?.effort, 'high');
  assertEquals(observed.reasoning?.summary, 'detailed');
  assertEquals(observed.text?.verbosity, 'medium');
  assertEquals(observed.service_tier, 'priority');
});

test('alias whose targets have no kind-matching binding surfaces as the regular model-missing 404', async () => {
  installRepo();
  queueResolution([], { sawModel: false });

  const result = await openaiResponsesServe.generate({
    payload: makePayload({ model: 'gpt-fast' }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.message, 'Model gpt-fast is not available on any configured upstream.');
});
