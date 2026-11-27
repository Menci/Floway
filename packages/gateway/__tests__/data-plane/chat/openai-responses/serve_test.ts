import { afterEach, test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from './test-policy.ts';
import { createOpenAIResponsesHttpStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesPayloadEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import { decodeResponseBody, type ModelCandidate, directFetcher, type UpstreamOpenAIResponsesResult, type UpstreamStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/upstream';

// Mock the resolver seam so each test hands the serve exactly the provider
// candidates it wants, optionally with an alias-rules overlay attached.
// `sawModel` is true when at least one candidate was queued; the
// `model-missing` failure test queues an empty list so the serve renders 404
// rather than 400.
interface QueuedResolution {
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
}
const resolutionsQueue: QueuedResolution[] = [];
const lastResolveCall: { model?: string } = {};
vi.mock('../../../../src/data-plane/upstreams/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/upstreams/resolution.ts')>();
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

const API_KEY_ID = 'key_serve_test';

const queueResolution = (
  candidates: readonly ModelCandidate[],
  aliasRules?: AliasRules,
): void => {
  resolutionsQueue.push({
    candidates: aliasRules !== undefined ? candidates.map(c => ({ ...c, rules: aliasRules })) : candidates,
    sawModel: candidates.length > 0,
  });
};

afterEach(() => { resolutionsQueue.length = 0; });

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: API_KEY_ID, userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, randomizeUpstreams: false, deletedAt: null, dumpRetentionSeconds: null,
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

const makeOpenAIResponsesResult = (id = 'resp_test'): OpenAIResponsesResultEx => ({
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
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamOpenAIResponsesResult>;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamStreamResult<AnthropicMessagesStreamEventEx>>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const instance = stubUpstream({
    callOpenAIResponses: overrides.callOpenAIResponses,
    callAnthropicMessages: overrides.callAnthropicMessages,
  });
  return {
    upstream: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      instance,
    },
    // Default keeps stubUpstreamModel's three-endpoint map intact; tests that
    // need a rejected candidate pass an explicit `endpoints` override.
    model: stubUpstreamModel({
      id: overrides.modelId ?? 'test-model',
      ...(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
    }),
    fetcher: directFetcher,
  };
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): Promise<OpenAIResponsesStreamEventEx[]> => {
  const out: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

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
  assertEquals(result.http.status, 400);
  const body = JSON.parse(decodeResponseBody(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(callOpenAIResponses.mock.calls.length, 0);
});

test('alias resolution swaps the inbound model id for the target and overlays rules onto the OpenAI Responses IR', async () => {
  installRepo();
  const capturedBodies: OpenAIResponsesPayloadEx[] = [];
  const observedModelIds: string[] = [];
  const callOpenAIResponses = vi.fn(async (model: unknown, body: unknown): Promise<UpstreamOpenAIResponsesResult> => {
    observedModelIds.push((model as { id: string }).id);
    capturedBodies.push(body as OpenAIResponsesPayloadEx);
    return { action: 'generate', ok: true, events: makeProtocolFrames([{ type: 'response.completed', sequence_number: 0, response: makeOpenAIResponsesResult() }]), modelKey: 'gpt-5.4', http: { status: 200, headers: new Headers() } };
  });
  const candidate = makeCandidate({ upstream: 'up_a', modelId: 'gpt-5.4', callOpenAIResponses });
  queueResolution([candidate], { reasoning: { effort: 'high', summary: 'detailed' }, verbosity: 'medium', serviceTier: 'priority' });

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
