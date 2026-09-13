import { expect, test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from './test-policy.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { hydrateOpenAIResponsesPayload } from '../../../../src/data-plane/chat/openai-responses/items/hydrate.ts';
import * as outputModule from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createOpenAIResponsesHttpStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { StoredOpenAIResponsesItem } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { acceptedAffinityEvaluation } from '../shared/affinity/helpers.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { OPENAI_RESPONSES_LITE_HEADER, toLiteOpenAIResponsesPayload, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesPayload, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderModel, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_attempt_test';

const makeGatewayCtx = (store?: ChatGatewayCtx['store']) =>
  mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true, ...(store ? { store } : {}) });

const makePayload = (overrides: Partial<CanonicalOpenAIResponsesPayload> = {}): CanonicalOpenAIResponsesPayload => ({
  model: 'test-model',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});

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

const makeProviderEvents = async function* (events: readonly OpenAIResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (
  callOpenAIResponses: (model: ProviderModel, body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: OpenAIResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>,
  enabledFlags: ReadonlySet<FlagId> = new Set<FlagId>(),
  endpoints: ModelEndpoints = { openaiResponses: {} },
): ModelCandidate => {
  const provider = stubProvider({ callOpenAIResponses });
  const upstream = 'up_test';
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
    model: stubInternalModel({
      endpoints,
      providerModels: { [upstream]: stubProviderModel({ enabledFlags, endpoints }) },
    }, upstream),
    fetcher: directFetcher,
  };
};

test('standard source is converted to Responses Lite for a Lite target', async () => {
  installRepo();
  const callOpenAIResponses = vi.fn(async (_model, body, _action, _signal, opts): Promise<ProviderOpenAIResponsesResult> => {
    assertEquals(opts.headers.get(OPENAI_RESPONSES_LITE_HEADER), 'true');
    assertEquals(body.instructions, undefined);
    assertEquals(body.tools, undefined);
    assertEquals(body.parallel_tool_calls, false);
    assertEquals(body.reasoning?.context, 'all_turns');
    assertEquals(body.input[0]?.type, 'additional_tools');
    return { action: 'generate', ok: true, events: makeProviderEvents([]), modelKey: 'test-model-key' };
  });
  await openaiResponsesAttempt.generate({
    payload: makePayload({
      instructions: 'Be concise.',
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses, new Set(), { openaiResponses: { transport: 'lite' } }),
    headers: new Headers(),
  });
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test.each([
  { sourceTransport: 'standard', tool: 'web_search', flag: 'openai-responses-web-search-shim' },
  { sourceTransport: 'lite', tool: 'web_search', flag: 'openai-responses-web-search-shim' },
  { sourceTransport: 'standard', tool: 'image_generation', flag: 'openai-responses-image-generation-shim' },
  { sourceTransport: 'lite', tool: 'image_generation', flag: 'openai-responses-image-generation-shim' },
] as const)('Responses Lite preserves $tool shim for a $sourceTransport source', async ({ sourceTransport, tool, flag }) => {
  installRepo();
  let capturedTools: unknown;
  let capturedInput: CanonicalOpenAIResponsesPayload['input'] | undefined;
  const completed = makeOpenAIResponsesResult();
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    const prefix = body.input[0];
    assert(prefix?.type === 'additional_tools');
    capturedTools = prefix.tools;
    capturedInput = body.input;
    assertEquals(body.tools, undefined);
    return {
      action: 'generate', ok: true,
      events: makeProviderEvents([
        { type: 'response.created', response: completed },
        { type: 'response.completed', response: completed },
      ]),
      modelKey: 'test-model-key',
    };
  });
  const sourcePayload = makePayload({ instructions: 'Be concise.', tools: [{ type: tool }] });
  const payload = sourceTransport === 'lite' ? toLiteOpenAIResponsesPayload(sourcePayload) : sourcePayload;
  const result = await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(
      callOpenAIResponses,
      new Set([flag]),
      { openaiResponses: { transport: 'lite' } },
    ),
    headers: new Headers(sourceTransport === 'lite' ? { [OPENAI_RESPONSES_LITE_HEADER]: 'true' } : undefined),
  });
  assertEquals(result.type, 'events');
  if (result.type === 'events') await collectEvents(result.events);
  expect(capturedTools).toEqual([{
    type: 'function',
    name: tool,
    description: expect.any(String),
    parameters: expect.any(Object),
    strict: false,
  }]);
  if (sourceTransport === 'lite') {
    const capturedPrefix = capturedInput?.[0];
    const sourcePrefix = payload.input[0];
    assert(capturedPrefix?.type === 'additional_tools' && sourcePrefix.type === 'additional_tools');
    expect(capturedPrefix.id).not.toEqual(sourcePrefix.id);
    assertEquals(capturedInput?.[1], payload.input[1]);
  }
});

test.each([
  { tool: 'web_search', flag: 'openai-responses-web-search-shim' },
  { tool: 'image_generation', flag: 'openai-responses-image-generation-shim' },
] as const)('Responses Lite shims a later $tool declaration without moving history', async ({ tool, flag }) => {
  installRepo();
  const source = toLiteOpenAIResponsesPayload(makePayload({ tools: [] }));
  source.input.push(
    {
      type: 'additional_tools', role: 'developer', id: 'at_later', tools: [
        { type: 'namespace', name: 'client', description: 'Client tools.', tools: [{ type: 'function', name: tool, parameters: { type: 'object' } }] },
        { type: tool },
      ],
    },
    { type: 'configuration_update', reasoning: { effort: 'high' } },
    { type: 'message', role: 'user', content: 'Use the new tool.' },
  );
  let captured: CanonicalOpenAIResponsesPayload['input'] | undefined;
  const completed = makeOpenAIResponsesResult();
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    captured = body.input;
    return {
      action: 'generate', ok: true, events: makeProviderEvents([
        { type: 'response.created', response: completed },
        { type: 'response.completed', response: completed },
      ]), modelKey: 'test-model-key',
    };
  });
  const result = await openaiResponsesAttempt.generate({
    payload: source,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses, new Set([flag]), { openaiResponses: { transport: 'lite' } }),
    headers: new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'true' }),
  });
  assertEquals(result.type, 'events');
  if (result.type === 'events') await collectEvents(result.events);
  assert(captured !== undefined);
  assertEquals(captured.slice(0, -3), source.input.slice(0, -3));
  assertEquals(captured.slice(-2), source.input.slice(-2));
  const later = captured.at(-3);
  const original = source.input.at(-3);
  assert(later?.type === 'additional_tools' && original?.type === 'additional_tools');
  assertEquals(later.tools[0], original.tools[0]);
  expect(later.tools[1]).toMatchObject({ type: 'function', name: `${tool}_2` });
  expect(later.id).not.toEqual(original.id);
});

test('Responses Lite preserves hosted tools for the upstream when no shim owns them', async () => {
  installRepo();
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    const prefix = body.input[0];
    assert(prefix?.type === 'additional_tools');
    assertEquals(prefix.tools, [{ type: 'web_search' }]);
    return { action: 'generate', ok: true, events: makeProviderEvents([]), modelKey: 'test-model-key' };
  });
  await openaiResponsesAttempt.generate({
    payload: makePayload({ tools: [{ type: 'web_search' }] }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses, new Set(), { openaiResponses: { transport: 'lite' } }),
    headers: new Headers(),
  });
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test.each([
  ['standard', 'lite'], ['lite', 'standard'], ['lite', 'lite'], ['standard', 'standard'],
] as const)('Responses %s to %s restores only converted request echoes and selects the client header', async (source, target) => {
  installRepo();
  const standard = makePayload({
    instructions: 'Client instructions', tools: [{ type: 'function', name: 'lookup' }],
    parallel_tool_calls: true, reasoning: { effort: 'high' },
  });
  const payload = source === 'lite' ? toLiteOpenAIResponsesPayload(standard) : standard;
  const upstream = {
    ...makeOpenAIResponsesResult(), tools: [], instructions: 'Upstream instructions',
    reasoning: { effort: 'low', context: 'all_turns' }, parallel_tool_calls: false,
    service_tier: 'effective_tier',
  };
  const candidate = makeCandidate(async () => ({
    action: 'generate', ok: true, modelKey: 'test-model-key',
    headers: new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: target === 'lite' ? 'true' : 'false', 'x-request-id': 'upstream-trace' }),
    events: makeProviderEvents([
      { type: 'response.created', response: upstream },
      { type: 'response.completed', response: upstream },
    ]),
  }), new Set(), { openaiResponses: { transport: target } });
  const result = await openaiResponsesAttempt.generate({
    payload, candidate, ctx: makeGatewayCtx(),
    headers: new Headers(source === 'lite' ? { [OPENAI_RESPONSES_LITE_HEADER]: 'true' } : {}),
  });
  assert(result.type === 'events');
  const responses = [];
  for await (const frame of result.events) {
    if (frame.type === 'event' && 'response' in frame.event) responses.push(frame.event.response);
  }
  assertEquals(responses.length, 2);
  for (const response of responses) {
    for (const field of ['tools', 'instructions', 'parallel_tool_calls', 'reasoning'] as const) {
      assertEquals(response[field], source === target ? upstream[field] : payload[field]);
    }
    assertEquals(response.service_tier, 'effective_tier');
    assertEquals(response.output, upstream.output);
  }
  assertEquals(result.headers?.get(OPENAI_RESPONSES_LITE_HEADER), source === 'lite' ? 'true' : null);
  assertEquals(result.headers?.get('x-request-id'), 'upstream-trace');
  assertEquals(upstream.instructions, 'Upstream instructions');
});

test('Responses Lite source is converted to standard for a standard target', async () => {
  installRepo();
  const source = makePayload({ instructions: 'Be concise.', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] });
  const callOpenAIResponses = vi.fn(async (_model, body, _action, _signal, opts): Promise<ProviderOpenAIResponsesResult> => {
    assertEquals(opts.headers.get(OPENAI_RESPONSES_LITE_HEADER), null);
    assertEquals(body.instructions, 'Be concise.');
    assertEquals(body.tools, source.tools);
    assertEquals(body.input, source.input);
    return { action: 'generate', ok: true, events: makeProviderEvents([]), modelKey: 'test-model-key' };
  });
  await openaiResponsesAttempt.generate({
    payload: toLiteOpenAIResponsesPayload(source),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses),
    headers: new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'true' }),
  });
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test.each(['generate', 'compact'] as const)('native Responses Lite %s preserves client prefix ids and metadata', async action => {
  installRepo();
  const source = toLiteOpenAIResponsesPayload(makePayload({
    instructions: 'Be concise.',
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' }, async: true }],
  }));
  assert(source.input[0].type === 'additional_tools' && source.input[1].type === 'message');
  Object.assign(source.input[0], { id: 'at_client_prefix', vendor_extension: 'keep-tools' });
  Object.assign(source.input[1], { id: 'msg_client_prefix', vendor_extension: 'keep-instructions' });
  const callOpenAIResponses = vi.fn(async (_model, body, actualAction, _signal, opts): Promise<ProviderOpenAIResponsesResult> => {
    assertEquals(actualAction, action);
    assertEquals(opts.headers.get(OPENAI_RESPONSES_LITE_HEADER), 'true');
    assertEquals(body.input, source.input);
    assertEquals(body.instructions, undefined);
    assertEquals(body.tools, undefined);
    return action === 'compact'
      ? { action, ok: true, result: makeOpenAIResponsesResult(), modelKey: 'test-model-key' }
      : { action, ok: true, events: makeProviderEvents([]), modelKey: 'test-model-key' };
  });
  await openaiResponsesAttempt.invoke({
    action,
    payload: source,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses, new Set(), { openaiResponses: { transport: 'lite' } }),
    headers: new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'true' }),
  });
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test.each(['generate', 'compact'] as const)('native Responses Lite %s keeps the compact and server-tool shims composed', async action => {
  installRepo();
  const source = toLiteOpenAIResponsesPayload(makePayload({
    instructions: 'Be concise.',
    tools: [{ type: 'web_search' }],
  }));
  // Codex omits internal message metadata when using a custom provider.
  const base = source.input[1];
  if (base.type !== 'message') throw new Error('Expected a base-instructions message');
  delete base.internal_chat_message_metadata_passthrough;
  source.input.splice(2, 0, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Project instructions.' }] });
  if (action === 'generate') source.input.push({ type: 'compaction_trigger' });
  const completed = makeOpenAIResponsesResult();
  const callOpenAIResponses = vi.fn(async (_model, body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, actualAction): Promise<ProviderOpenAIResponsesResult> => {
    assertEquals(actualAction, 'generate');
    const prefix = body.input[0];
    assert(prefix.type === 'additional_tools');
    expect(prefix.tools).toEqual([expect.objectContaining({ type: 'function', name: 'web_search' })]);
    assertEquals(body.input.slice(1, 3), source.input.slice(1, 3));
    const compactor = body.input[3];
    assert(compactor.type === 'message' && Array.isArray(compactor.content));
    assertEquals(compactor.role, 'system');
    expect(compactor.content[0]).toEqual(expect.objectContaining({ type: 'input_text', text: expect.stringContaining('CONTEXT CHECKPOINT COMPACTION') }));
    assertEquals(body.input[4], source.input[3]);
    assert(!body.input.some(item => item.type === 'compaction_trigger'));
    assertEquals(body.tools, undefined);
    return {
      action: 'generate', ok: true,
      events: makeProviderEvents([
        { type: 'response.created', response: completed },
        { type: 'response.output_item.added', output_index: 0, item: completed.output[0] },
        { type: 'response.output_item.done', output_index: 0, item: completed.output[0] },
        { type: 'response.completed', response: completed },
      ]),
      modelKey: 'test-model-key',
    };
  });
  const result = await openaiResponsesAttempt.invoke({
    action, payload: source, ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses, new Set(['openai-responses-compact-shim', 'openai-responses-web-search-shim']), { openaiResponses: { transport: 'lite' } }),
    headers: new Headers({ [OPENAI_RESPONSES_LITE_HEADER]: 'true' }),
  });
  if (result.type === 'events') await collectEvents(result.events);
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test.each(['standard', 'lite'] as const)('Lite role flags preserve leading instructions for a %s source', async sourceTransport => {
  installRepo();
  const source = makePayload({
    instructions: 'Base instructions.',
    input: [
      {
        type: 'message', role: 'developer',
        content: [{ type: 'input_text', text: 'A base fragment.' }, { type: 'input_text', text: 'Project instructions.' }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions', 'project.instructions'] },
      },
      { type: 'configuration_update', reasoning: { effort: 'high' } },
      { type: 'message', role: 'system', content: 'Leading system instructions.' },
      { type: 'message', role: 'user', content: 'Hello.' },
      { type: 'message', role: 'system', content: 'Later system instructions.' },
    ],
  });
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    assertEquals(body.input[0].type, 'additional_tools');
    expect(body.input[1]).toMatchObject({ type: 'message', role: 'developer' });
    assertEquals(body.input[2], { ...source.input[0], role: 'system' });
    assertEquals(body.input[3], source.input[1]);
    assertEquals(body.input[4], source.input[2]);
    assertEquals(body.input[6], { ...source.input[4], role: 'user' });
    return { action: 'generate', ok: true, events: makeProviderEvents([]), modelKey: 'test-model-key' };
  });
  await openaiResponsesAttempt.generate({
    payload: sourceTransport === 'lite' ? toLiteOpenAIResponsesPayload(source) : source,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses, new Set(['rewrite-developer-to-system', 'rewrite-mid-conv-system-to-user']), { openaiResponses: { transport: 'lite' } }),
    headers: new Headers(sourceTransport === 'lite' ? { [OPENAI_RESPONSES_LITE_HEADER]: 'true' } : undefined),
  });
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

const collectEvents = async (events: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): Promise<OpenAIResponsesStreamEvent[]> => {
  const out: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

const installRepo = () => {
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

const insertStoredItem = async (repo: InMemoryRepo, overrides: Partial<StoredOpenAIResponsesItem> & Pick<StoredOpenAIResponsesItem, 'id'> & { type: string }): Promise<StoredOpenAIResponsesItem> => {
  const { type, ...itemOverrides } = overrides;
  const row: StoredOpenAIResponsesItem = {
    apiKeyId: API_KEY_ID,
    itemHash: `hash-${overrides.id}`,
    payload: { item: { type, id: overrides.id } },
    refreshedAt: Date.now(),
    ...itemOverrides,
  };
  await repo.openaiResponsesItems.insertMany([row], 0);
  return row;
};

test('generate native success leaves source-edge state ownership to the caller', async () => {
  installRepo();

  const completedEvent: OpenAIResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeOpenAIResponsesResult(),
  };
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));

  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const ctx = makeGatewayCtx(store);

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload(),
    ctx,
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');

  const events = await collectEvents(result.events);
  assert(events.length >= 1, 'expected at least the response.completed event');

  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test('generate isolates provider mutations with JSON-safe container cloning', async () => {
  installRepo();
  const metadata = JSON.parse('{"__proto__":{"retained":true},"nested":{"value":"source"}}') as Record<string, unknown>;
  const payload = makePayload({ metadata });
  const sourceItem = payload.input[0];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    const clonedMetadata = body.metadata as { nested: { value: string } } & Record<string, unknown>;
    assert(Object.hasOwn(clonedMetadata, '__proto__'), 'clone lost the own __proto__ JSON field');
    clonedMetadata.nested.value = 'provider';
    (body.input[0] as { role: string }).role = 'assistant';
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([]),
      modelKey: 'test-model-key',
    };
  });

  await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses),
    headers: new Headers(),
  });

  assertEquals((payload.metadata as { nested: { value: string } }).nested.value, 'source');
  assertEquals((sourceItem as { role: string }).role, 'user');
});

test('generate treats a translated OpenAI Responses payload as opaque to native affinity and state', async () => {
  installRepo();
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
  ): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeOpenAIResponsesResult(),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const ctx = makeGatewayCtx(store);
  const carrier = await ctx.affinity.codec.wrap(
    undefined,
    {
      upstreamId: candidate.provider.upstreamId,
      modelId: candidate.model.id,
    },
    'openai-responses.reasoning.encrypted_content',
  );
  const unwrap = vi.spyOn(ctx.affinity.codec, 'unwrap');
  const getStoredItem = vi.spyOn(store, 'getItemById');
  const itemId = 'rs_source_edge';

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [{ type: 'reasoning', id: itemId, summary: [], encrypted_content: carrier }],
    }),
    ctx,
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(unwrap.mock.calls.length, 0);
  assertEquals(getStoredItem.mock.calls.length, 0);
  assertEquals(observedBody?.input, [{ type: 'reasoning', id: itemId, summary: [], encrypted_content: carrier }]);
});

test('generate applies role compatibility flags in target-chain order', async () => {
  installRepo();
  let observedBody: Omit<OpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<OpenAIResponsesPayload, 'model'>,
  ): Promise<ProviderOpenAIResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeOpenAIResponsesResult(),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate(callOpenAIResponses, new Set([
    'rewrite-developer-to-system',
    'rewrite-mid-conv-system-to-user',
    'rewrite-system-to-developer',
  ]));

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.input, [
    { type: 'message', role: 'system', content: 'base instructions' },
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'user', content: 'inline instructions' },
  ]);
});

test('generate defers the role rewrite until after translation to OpenAI Chat Completions', async () => {
  installRepo();
  let observedBody: Omit<OpenAIChatCompletionsPayload, 'model'> | undefined;
  const callOpenAIChatCompletions = vi.fn(async (
    _model: ProviderModel,
    body: Omit<OpenAIChatCompletionsPayload, 'model'>,
  ): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    observedBody = body;
    return {
      ok: true,
      events: (async function* () {
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        });
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        yield doneFrame();
      })(),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const upstream = 'up_chat';
  const endpoints = { openaiChatCompletions: {} };
  const candidate: ModelCandidate = {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: stubProvider({ callOpenAIChatCompletions }),
    },
    model: stubInternalModel({
      endpoints,
      providerModels: {
        [upstream]: stubProviderModel({
          endpoints,
          enabledFlags: new Set(['rewrite-system-to-developer']),
        }),
      },
    }, upstream),
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.messages, [
    { role: 'developer', content: 'base instructions' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: 'inline instructions' },
  ]);
});

test('generate passes non-events provider result through unchanged', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapOpenAIResponsesClientOutput');

  const upstreamResponse = new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 502, headers: new Headers({ 'content-type': 'application/json' }) });
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: false,
    response: upstreamResponse,
    modelKey: 'test-model-key',
  }));

  const candidate = makeCandidate(callOpenAIResponses);
  const result = await openaiResponsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 502);
  // Wrap must not run when the upstream failed before any events flowed.
  assertEquals(wrapSpy.mock.calls.length, 0);
  wrapSpy.mockRestore();
});

test('compact returns the clean upstream result for source-edge affinity and storage', async () => {
  installRepo();

  // Native /responses/compact returns a fully-shaped compaction envelope —
  // the `action: 'compact'` branch of `provider.callOpenAIResponses` does the
  // Copilot compaction_trigger reshape internally — so the attempt receives
  // a OpenAIResponsesResult, expands it into synthetic frames, and wraps the
  // output for storage. The synthesized envelope carries a `compaction`
  // output item; wrap observes it and derives the 'replace' snapshot.
  const compactionItem = {
    type: 'compaction' as const,
    id: 'cmp_1',
    encrypted_content: 'ENC',
  };
  const compactionResult: OpenAIResponsesResult = {
    ...makeOpenAIResponsesResult(),
    object: 'response.compaction',
    // Cast: `compaction` is an input-shaped item type the protocol's
    // OpenAIResponsesResult.output type does not include but the runtime accepts.
    output: [compactionItem] as unknown as OpenAIResponsesResult['output'],
  };

  const callOpenAIResponses = vi.fn(async (_model: ProviderModel, _body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: OpenAIResponsesAction): Promise<ProviderOpenAIResponsesResult> => {
    if (action !== 'compact') throw new Error(`compact candidate received action='${action}'`);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });

  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const result = await openaiResponsesAttempt.invoke({
    payload: makePayload({
      input: [
        { type: 'message', role: 'user', content: 'kept message' },
      ],
    }),
    action: 'compact',
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(result.result.output.length, 1);
  assertEquals((result.result.output[0] as { id: string }).id, 'cmp_1');
  assertEquals(result.result.id, compactionResult.id);
});

test('generate strips disallowed headers and injects external image loading across translation to Anthropic Messages', async () => {
  installRepo();
  initExternalResourceFetcher(url => {
    assertEquals(url.href, 'https://example.com/image.png');
    return Promise.resolve(new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }));
  });
  let observedHeaders: Headers | undefined;
  let observedAnthropicBeta: readonly string[] | undefined;
  let observedBody: Omit<AnthropicMessagesPayload, 'model'> | undefined;
  const upstreamModel = stubInternalModel({ endpoints: { anthropicMessages: {} } }, 'up_test');
  const anthropicMessagesProvider = stubProvider({
    callAnthropicMessages: async (_model, body, _signal, opts): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
      observedHeaders = opts.headers;
      observedAnthropicBeta = (opts as AnthropicMessagesUpstreamCallOptions).anthropicBeta;
      observedBody = body as Omit<AnthropicMessagesPayload, 'model'>;
      return {
        ok: true,
        events: (async function* () {
          yield eventFrame<AnthropicMessagesStreamEvent>({
            type: 'message_start',
            message: {
              id: 'msg_1', type: 'message', role: 'assistant', content: [],
              model: 'test-model', stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          });
          yield eventFrame<AnthropicMessagesStreamEvent>({ type: 'message_stop' });
          yield doneFrame();
        })(),
        modelKey: 'k',
        headers: new Headers(),
      };
    },
  });
  const candidate: ModelCandidate = {
    provider: {
      upstreamId: 'up_test', kind: 'custom', name: 'up_test', inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: anthropicMessagesProvider,
    },
    model: upstreamModel,
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/image.png', detail: 'auto' }],
      }],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
    candidate,
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols', 'x-test': 'abc' }),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedHeaders?.get('x-test'), null);
  assertEquals(observedHeaders?.get('anthropic-beta'), null);
  assertEquals(observedAnthropicBeta, []);
  const message = observedBody?.messages[0];
  assert(message?.role === 'user' && Array.isArray(message.content));
  const image = message.content.find(block => block.type === 'image');
  assert(image?.type === 'image');
  assertEquals(image.source, { type: 'base64', media_type: 'image/png', data: 'AQID' });
});

test('generate seeds privatePayload before interceptors so the web-search shim replays the prior wsc results on echo', async () => {
  // End-to-end contract: when a stateless client (e.g. Codex CLI) echoes a
  // prior gateway-created web_search_call by its emitted id, the web-search shim's
  // `transformItems` (which runs as part of the interceptor chain) must
  // find the persisted `payload.private` and emit the cached function_call
  // + function_call_output pair to upstream — NOT the not-preserved
  // placeholder.
  //
  // The wire shape we model here:
  //   - row.id = the public item id echoed as `wsc.id`.
  //   - payload.item.id = that same public id.
  //   - payload.private = WebSearchCallPrivatePayload (v:1, functionCallItem, ir).
  //
  // This regression caught a prior ordering bug where hydration + beginAttempt
  // ran inside the interceptor closure, after the shim's input transform —
  // so privatePayload was always empty when the shim looked it up, and
  // every echoed wsc collapsed to the placeholder.
  const repo = installRepo();
  const storedId = `ws_${'a'.repeat(32)}`;
  const storedItem = {
    type: 'web_search_call' as const,
    id: storedId,
    status: 'completed' as const,
    action: { type: 'search' as const, query: 'deepseek v4', queries: ['deepseek v4'] },
  };
  await insertStoredItem(repo, {
    id: storedId,
    type: 'web_search_call',
    payload: {
      item: storedItem,
      private: {
        v: 1,
        functionCallItem: {
          type: 'function_call',
          call_id: 'call_orig_xyz',
          name: 'web_search',
          arguments: '{"search_query":[{"q":"deepseek v4"}]}',
          status: 'completed',
        },
        ir: {
          action: { type: 'search', query: 'deepseek v4', queries: ['deepseek v4'] },
          results: [{ type: 'text_result', url: 'https://example.com', title: 'Example', snippet: 'CACHED_SNIPPET_BODY' }],
        },
      },
    },
  });

  // Capture the upstream-bound body so we can verify what the shim produced
  // after the echoed wsc passed through transformItems.
  let capturedBody: { input?: unknown[] } | undefined;
  const upstreamResponse = makeOpenAIResponsesResult();
  // The shim's multi-turn loop requires `response.created` (carrying a model
  // name) before any synthesized terminal envelope. Emit the canonical
  // created → in_progress → completed sequence so the shim can wrap.
  const upstreamEvents: OpenAIResponsesStreamEvent[] = [
    { type: 'response.created', sequence_number: 0, response: upstreamResponse },
    { type: 'response.in_progress', sequence_number: 1, response: upstreamResponse },
    { type: 'response.completed', sequence_number: 2, response: upstreamResponse },
  ];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    capturedBody = body as { input?: unknown[] };
    return { action: 'generate', ok: true, events: makeProviderEvents(upstreamEvents), modelKey: 'test-model-key', headers: new Headers() };
  });
  const candidate = makeCandidate(callOpenAIResponses, new Set(['openai-responses-web-search-shim']));

  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  await store.loadInputItems([{ type: 'web_search_call', id: storedId }], []);
  const ctx = makeGatewayCtx(store);
  const carrier = await ctx.affinity.codec.wrap(
    undefined,
    {
      upstreamId: candidate.provider.upstreamId,
      modelId: candidate.model.id,
    },
    'openai-responses.reasoning.encrypted_content',
    { syntheticItem: true },
  );

  const sourcePayload = makePayload({
    input: [
      { type: 'message', role: 'user', content: 'follow-up' },
      { type: 'reasoning', id: 'rs_affinity', summary: [], encrypted_content: carrier },
      {
        type: 'web_search_call',
        id: storedId,
        status: 'completed',
        action: { type: 'search', queries: ['deepseek v4'] },
      } as unknown as never,
    ],
    tools: [{ type: 'web_search' }],
  });
  await store.loadInputItems(sourcePayload.input, sourcePayload.input);
  const hydrated = hydrateOpenAIResponsesPayload(sourcePayload, store);
  const affinity = await analyzeOpenAIResponsesAffinity(hydrated.payload, ctx.affinity.codec);
  const result = await openaiResponsesAttempt.generate({
    payload: acceptedAffinityEvaluation(affinity, candidate).materialize(),
    sourceState: {
      privatePayloads: hydrated.privatePayloads,
    },
    ctx,
    candidate,
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  assert(capturedBody !== undefined, 'callOpenAIResponses was not invoked');
  const input = (capturedBody!.input ?? []) as Array<{ type: string; call_id?: string; output?: string; name?: string; arguments?: string }>;
  // The wsc echo MUST be replaced by the recovered function_call + output pair,
  // carrying the persisted call_id and the cached snippet body verbatim.
  const fc = input.find(i => i.type === 'function_call' && i.call_id === 'call_orig_xyz');
  assert(fc !== undefined, 'expected replayed function_call with the persisted call_id');
  assertEquals(fc!.name, 'web_search');
  assertEquals(fc!.arguments, '{"search_query":[{"q":"deepseek v4"}]}');
  const fco = input.find(i => i.type === 'function_call_output' && i.call_id === 'call_orig_xyz');
  assert(fco !== undefined, 'expected replayed function_call_output');
  assert(fco!.output?.includes('CACHED_SNIPPET_BODY'), `expected cached body in function_call_output, got: ${fco!.output}`);
  // And the not-preserved placeholder MUST NOT appear.
  assert(
    !input.some(i => i.type === 'function_call_output' && typeof i.output === 'string' && i.output.includes('Prior search results were not preserved')),
    'shim emitted the not-preserved placeholder despite a stored private payload',
  );
});

test('generate propagates upstream response headers onto the EventResult so respond can forward them', async () => {
  installRepo();
  const completedEvent: OpenAIResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeOpenAIResponsesResult(),
  };
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'request-id': 'req_resp_xyz',
  });
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
    headers: upstreamHeaders,
  }));
  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const result = await openaiResponsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('request-id'), 'req_resp_xyz');
  await collectEvents(result.events);
});
