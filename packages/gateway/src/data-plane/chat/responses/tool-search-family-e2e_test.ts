// End-to-end integration test for the tool_search family fold + unprefix flow.
//
// Drives `responsesAttempt.generate` with a payload carrying the full family
// (`additional_tools` input item with a `namespace` container of function
// sub-tools, plus top-level `tool_search` / `programmatic_tool_calling`
// hosted entries and `defer_loading` / `allowed_callers` fields) against a
// mocked chat-completions candidate. Verifies:
//
//   1. flag on — outbound body captured by the mock has:
//      - no `additional_tools` item in input
//      - flat tools[] with sub-tool names prefixed `<namespace>__`
//      - no `tool_search` / `programmatic_tool_calling` entries
//      - no `defer_loading` / `allowed_callers` fields on remaining tools
//   2. flag on — upstream returns a Chat Completions tool_call named
//      `collaboration__spawn_agent`; the client-facing Responses event
//      stream carries a `function_call` output item with the bare name
//      `spawn_agent` (proves `withUnprefixNamespaceToolCalls` ran on the
//      translated response stream).
//   3. flag off — translator throws `Invalid input item type 'additional_tools'`,
//      surfacing as a 400 `api-error` result (proves both Layer 1
//      store-passthrough is intact — no 502 at ingress — and that the fold
//      interceptor is what removes `additional_tools` from input when the
//      flag is on).

import { test, vi } from 'vitest';

import { responsesAttempt } from './attempt.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-helpers/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type FlagId, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_tool_search_e2e';

const chatCompletionsCandidate = (
  callChatCompletions: (model: unknown, body: unknown, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>,
  enabledFlags: ReadonlySet<FlagId>,
): ModelCandidate => {
  const endpoints: ModelEndpoints = { chatCompletions: {} };
  const upstream = 'up_test';
  const providerModel = stubProviderModel({ id: 'test-model', kind: 'chat', endpoints, enabledFlags });
  return {
    provider: {
      upstream,
      kind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      modelPrefix: null,
      instance: stubProvider({ callChatCompletions }),
      supportsResponsesItemReference: false,
    },
    model: stubInternalModel({ id: 'test-model', kind: 'chat', endpoints, providerModels: { [upstream]: providerModel } }, upstream),
    fetcher: directFetcher,
  };
};

const chatCompletionsToolCallStream = (functionName: string): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> => {
  const chunk = (delta: Partial<ChatCompletionsStreamEvent['choices'][number]['delta']>, finish_reason: ChatCompletionsStreamEvent['choices'][number]['finish_reason'] = null): ChatCompletionsStreamEvent => ({
    id: 'chatcmpl_test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason }],
  });
  const events: ChatCompletionsStreamEvent[] = [
    chunk({ role: 'assistant', content: null }),
    chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: functionName, arguments: '' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"name":"researcher","prompt":"hi"}' } }] }),
    chunk({}, 'tool_calls'),
  ];
  return (async function* () {
    for (const event of events) yield eventFrame(event);
    yield doneFrame();
  })();
};

const installRepo = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makePayload = (): CanonicalResponsesPayload => ({
  model: 'test-model',
  input: [
    { type: 'message', role: 'user', content: 'delegate this' },
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [
        { type: 'function', name: 'wait', parameters: { type: 'object' }, strict: false },
        {
          type: 'namespace',
          name: 'collaboration',
          tools: [
            { type: 'function', name: 'spawn_agent', parameters: { type: 'object' }, strict: false, defer_loading: true },
            { type: 'function', name: 'send_message', parameters: { type: 'object' }, strict: false },
          ],
        },
      ],
    },
  ] as CanonicalResponsesPayload['input'],
  tools: [
    { type: 'function', name: 'keep_me', parameters: { type: 'object' }, strict: false, allowed_callers: ['programmatic'] },
    { type: 'tool_search' },
    { type: 'programmatic_tool_calling' },
  ],
});

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) if (frame.type === 'event') out.push(frame.event);
  return out;
};

test('flag on — outbound Chat Completions body is fully desugared', async () => {
  installRepo();
  const outboundBody = vi.fn();
  const callChatCompletions = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
    outboundBody(body);
    return { ok: true, events: chatCompletionsToolCallStream('collaboration__spawn_agent'), modelKey: 'test-model-key', headers: new Headers() };
  });
  const candidate = chatCompletionsCandidate(callChatCompletions, new Set<FlagId>(['flatten-tool-search-family']));
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const ctx = mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true, store });
  vi.spyOn(store, 'commitSnapshot').mockResolvedValue();

  const result = await responsesAttempt.generate({ payload: makePayload(), ctx, candidate, headers: new Headers() });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  assertEquals(outboundBody.mock.calls.length, 1);
  const body = outboundBody.mock.calls[0][0] as { messages: unknown[]; tools: { type: string; function: { name: string; description?: string } }[] };

  // No additional_tools item survives — the interceptor stripped it before
  // the translator ran. If it were still in input, the translator would have
  // thrown before reaching this mock.
  const messages = body.messages as { role: string; content: unknown }[];
  assert(!messages.some(m => (m as { type?: string }).type === 'additional_tools'), 'additional_tools must not appear in translated messages');

  // Chat Completions wraps custom + function tools as function tools.
  const toolNames = body.tools.map(t => t.function.name);
  assert(toolNames.includes('wait'), 'top-level `wait` function survives');
  assert(toolNames.includes('keep_me'), 'top-level `keep_me` function survives');
  assert(toolNames.includes('collaboration__spawn_agent'), 'namespace sub-tool prefixed as collaboration__spawn_agent');
  assert(toolNames.includes('collaboration__send_message'), 'namespace sub-tool prefixed as collaboration__send_message');
  // Dropped by flattenToolSearchFamilyTools.
  assert(!toolNames.includes('tool_search'), '`tool_search` hosted entry dropped');
  assert(!toolNames.includes('programmatic_tool_calling'), '`programmatic_tool_calling` hosted entry dropped');
  // Fields stripped.
  const keepMeTool = body.tools.find(t => t.function.name === 'keep_me') as { function: { allowed_callers?: unknown } };
  assertEquals((keepMeTool.function as { allowed_callers?: unknown }).allowed_callers, undefined);
  const collabSpawn = body.tools.find(t => t.function.name === 'collaboration__spawn_agent') as { function: { defer_loading?: unknown } };
  assertEquals((collabSpawn.function as { defer_loading?: unknown }).defer_loading, undefined);
});

test('flag on — response tool_call name is unprefixed at client egress', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: chatCompletionsToolCallStream('collaboration__spawn_agent'), modelKey: 'test-model-key', headers: new Headers(),
  }));
  const candidate = chatCompletionsCandidate(callChatCompletions, new Set<FlagId>(['flatten-tool-search-family']));
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const ctx = mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true, store });
  vi.spyOn(store, 'commitSnapshot').mockResolvedValue();

  const result = await responsesAttempt.generate({ payload: makePayload(), ctx, candidate, headers: new Headers() });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  const events = await collectEvents(result.events);

  // Locate the function_call output item — either on `output_item.done` or
  // inside the terminal envelope.
  const doneFrame = events.find(e => e.type === 'response.output_item.done' && (e as { item: { type: string } }).item.type === 'function_call') as { item: { type: string; name: string } } | undefined;
  const completedFrame = events.find(e => e.type === 'response.completed') as { response: { output: { type: string; name?: string }[] } } | undefined;
  const namesFromDone = doneFrame ? [doneFrame.item.name] : [];
  const namesFromCompleted = completedFrame?.response.output.filter(i => i.type === 'function_call').map(i => i.name!) ?? [];
  const allNames = [...namesFromDone, ...namesFromCompleted];

  assert(allNames.length > 0, 'expected at least one function_call output item');
  for (const name of allNames) {
    assertEquals(name, 'spawn_agent', `expected bare name, got ${name}`);
    assert(!name.includes('__'), `namespace prefix must be stripped, got ${name}`);
  }
});

test('flag off — translator throws TranslatorInputError on additional_tools (rendered as 400 one layer up)', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
    throw new Error('callChatCompletions should not be invoked when translator rejects input');
  });
  const candidate = chatCompletionsCandidate(callChatCompletions, new Set<FlagId>());
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const ctx = mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true, store });

  // At the attempt.ts layer the error propagates raw; serve.ts's caller
  // catches and renders it via translatorInputErrorResult. We assert on the
  // raw throw here — that is the observable signal that the fold
  // interceptor DID NOT run (otherwise `additional_tools` would have been
  // stripped from input before the translator saw it).
  let thrown: unknown = null;
  try {
    await responsesAttempt.generate({ payload: makePayload(), ctx, candidate, headers: new Headers() });
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null, 'expected translator to throw when flag is off');
  const err = thrown as { name?: string; message?: string };
  assertEquals(err.name, 'TranslatorInputError');
  assert(err.message?.includes('additional_tools') ?? false, `expected additional_tools in error, got: ${err.message}`);
  assertEquals(callChatCompletions.mock.calls.length, 0);
});
