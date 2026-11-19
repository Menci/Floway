import { afterEach, test, vi } from 'vitest';

import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { type ModelCandidate, directFetcher, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

// Mock the resolver seam so each test hands the serve exactly the model
// candidates it wants, optionally with an alias-rules overlay attached.
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

const { openaiChatCompletionsServe } = await import('../../../../src/data-plane/chat/openai-chat-completions/serve.ts');

const API_KEY_ID = 'key_chat_completions_serve_test';

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
  return repo;
};

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<OpenAIChatCompletionsPayloadEx> = {}): OpenAIChatCompletionsPayloadEx => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeOpenAIChatCompletionsEvents = (): readonly OpenAIChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{  index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{  index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  modelId?: string;
  endpoints?: ModelEndpoints;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: provider,
    },
    model: stubInternalModel({
      id: overrides.modelId ?? 'test-model',
      ...(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
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

test('generate filters out candidates that do not expose any chat-completions-target endpoint', async () => {
  installRepo();
  const callOpenAIChatCompletions = vi.fn();
  // `openaiCompletions:{}` is not in the openaiChatCompletionsTarget preference list
  // (`openai-chat-completions` > `messages` > `responses`), so the picker rejects
  // this candidate.
  queueResolution([makeCandidate({ upstream: 'up_m', endpoints: { openaiCompletions: {} }, callOpenAIChatCompletions })]);

  const result = await openaiChatCompletionsServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  // canServe drops messages-only candidates; with no viable candidate the
  // serve renders model-unsupported as a 400 api-error (distinct from the
  // model-missing 404) without ever reaching the upstream call.
  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.http.status, 400);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 0);
});

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
  installRepo();
  const originalImageUrl = 'data:image/png;base64,AQID';
  const payload = makePayload({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: originalImageUrl, detail: 'auto' } }],
    }],
  });
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    const message = (body as Omit<OpenAIChatCompletionsPayloadEx, 'model'>).messages[0];
    if (!Array.isArray(message.content) || message.content[0]?.type !== 'image_url') throw new Error('expected image content');
    message.content[0].image_url.url = 'data:image/webp;base64,COMPRESSED';
    return { ok: false, http: firstError, modelKey: 'first-key' };
  });
  let fallbackImageUrl: string | undefined;
  const secondCall = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    const message = (body as Omit<OpenAIChatCompletionsPayloadEx, 'model'>).messages[0];
    if (!Array.isArray(message.content) || message.content[0]?.type !== 'image_url') throw new Error('expected image content');
    fallbackImageUrl = message.content[0].image_url.url;
    return { ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'second-key', http: { status: 200, headers: new Headers() } };
  });
  queueResolution([
    makeCandidate({ upstream: 'up_a', callOpenAIChatCompletions: firstCall }),
    makeCandidate({ upstream: 'up_b', callOpenAIChatCompletions: secondCall }),
  ]);

  const result = await openaiChatCompletionsServe.generate({
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
  const sourceMessage = payload.messages[0];
  if (!Array.isArray(sourceMessage.content) || sourceMessage.content[0]?.type !== 'image_url') throw new Error('expected source image content');
  assertEquals(sourceMessage.content[0].image_url.url, originalImageUrl);
});

test('alias resolution swaps the inbound model id for the target and overlays rules onto the IR', async () => {
  installRepo();
  const capturedBodies: OpenAIChatCompletionsPayloadEx[] = [];
  const observedModelIds: string[] = [];
  const callOpenAIChatCompletions = vi.fn(async (model: unknown, body: unknown): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    observedModelIds.push((model as { id: string }).id);
    capturedBodies.push(body as OpenAIChatCompletionsPayloadEx);
    return { ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'gpt-5.4', http: { status: 200, headers: new Headers() } };
  });
  // Alias flow shape: the resolver returns candidates carrying the target's
  // upstream catalog id AND the alias's rule overlay on `candidate.rules`.
  // The attempt stamps its private clone with `candidate.model.id` and reads
  // the overlay directly off `candidate.rules` at wire-call time.
  const candidate = makeCandidate({ upstream: 'up_a', modelId: 'gpt-5.4', callOpenAIChatCompletions });
  queueResolution([candidate], { aliasRules: { reasoning: { effort: 'low' }, verbosity: 'low' } });

  const payload = makePayload({ model: 'gpt-fast' });
  const result = await openaiChatCompletionsServe.generate({
    payload,
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  // The resolver saw the inbound alias id verbatim — target-id walking
  // happens inside the resolver, not in serve.
  assertEquals(lastResolveCall.model, 'gpt-fast');
  assertEquals(observedModelIds, ['gpt-5.4']);
  assertEquals(payload.model, 'gpt-fast');
  // Alias rules land on the IR through candidate.rules → the attempt's
  // applyRulesToUpstreamOpenAIChatCompletions call.
  const observed = capturedBodies[0]!;
  assertEquals(observed.reasoning_effort, 'low');
  assertEquals(observed.verbosity, 'low');
});
