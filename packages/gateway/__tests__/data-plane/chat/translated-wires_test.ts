// The translated wires, run end to end — one row per (source, target) pair.
//
// The property each row states is the same, and it is the one nothing else can state: a
// candidate reachable *only* over another protocol's endpoint is dialled there rather than
// refused or dialled on the wrong wire, and what comes back reaches the client in the
// client's own protocol. The candidates here carry exactly one endpoint each, so a chain that
// picked any other wire would call a provider method that throws.
//
// Beside the matrix, three things that are about the fork rather than about a pair: that
// failover moves from a native candidate onto a translated one, that a pair's own refusal
// rewrite survives the trip, and that a rule which speaks about one protocol's wire does not
// run on a turn that leaves for another — which is what the replaced surface said with
// `ctx.targetApi !== <self>` and what position says here.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { anthropicMessagesServePipeline, anthropicMessagesWire } from '../../../src/data-plane/chat/anthropic-messages/pipeline.ts';
import { geminiGenerateContentServePipeline } from '../../../src/data-plane/chat/gemini-generate-content/pipeline.ts';
import { handOff } from '../../../src/data-plane/chat/handoff.ts';
import { openaiChatCompletionsServePipeline } from '../../../src/data-plane/chat/openai-chat-completions/pipeline.ts';
import { openaiResponsesServePipeline } from '../../../src/data-plane/chat/openai-responses/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, move, run, type Pipeline } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE, type AnthropicMessagesPayload, type AnthropicMessagesResult, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentResult } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsResult, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { directFetcher, type FlagId, type ModelCandidate, type ProviderOpenAIResponsesResult, type ProviderStreamResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

const MODEL = 'model-x';

let live: readonly ModelCandidate[] = [];

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] } as never);
};

interface Calls {
  readonly callOpenAIChatCompletions?: (model: unknown, body: unknown) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
  readonly callAnthropicMessages?: (model: unknown, body: unknown) => Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>>;
  readonly callOpenAIResponses?: (model: unknown, body: unknown) => Promise<ProviderOpenAIResponsesResult>;
}

/** A candidate reachable over exactly the endpoints it is given. Handing it one endpoint is
 *  what pins the wire: every provider method the stub was not given throws, so a chain that
 *  picked another wire fails loudly rather than quietly answering. */
const candidate = (
  upstreamId: string,
  endpoints: ModelEndpoints,
  calls: Calls,
  flags: readonly FlagId[] = [],
): ModelCandidate => ({
  provider: {
    upstreamId, kind: 'custom', name: upstreamId, inboundHeaderAllowlist: [],
    disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
    instance: stubProvider(calls as never),
  },
  model: stubInternalModel(
    {
      id: MODEL,
      endpoints,
      providerModels: { [upstreamId]: stubProviderModel({ id: MODEL, endpoints, enabledFlags: new Set(flags) }) },
    },
    upstreamId,
  ),
  fetcher: directFetcher,
} as unknown as ModelCandidate);

// ── What each wire answers with ───────────────────────────────────────────────────────────

const openaiChatCompletionsTurn = (text: string): ProviderStreamResult<OpenAIChatCompletionsStreamEvent> => ({
  ok: true,
  modelKey: 'k',
  headers: new Headers(),
  events: (async function* () {
    yield eventFrame({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    } as OpenAIChatCompletionsStreamEvent);
    yield eventFrame({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    } as OpenAIChatCompletionsStreamEvent);
    yield doneFrame();
  })(),
});

const anthropicMessagesTurn = (text: string): ProviderStreamResult<AnthropicMessagesStreamEvent> => ({
  ok: true,
  modelKey: 'k',
  headers: new Headers(),
  events: (async function* () {
    yield eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', content: [], model: MODEL,
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 },
      },
    } as AnthropicMessagesStreamEvent);
    yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as AnthropicMessagesStreamEvent);
    yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as AnthropicMessagesStreamEvent);
    yield eventFrame({ type: 'content_block_stop', index: 0 } as AnthropicMessagesStreamEvent);
    yield eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } as AnthropicMessagesStreamEvent);
    yield eventFrame({ type: 'message_stop' } as AnthropicMessagesStreamEvent);
    yield doneFrame();
  })(),
});

const openaiResponsesResult = (text: string): OpenAIResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: MODEL,
  status: 'completed',
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }],
  error: null,
  incomplete_details: null,
});

const openaiResponsesTurn = (text: string): ProviderOpenAIResponsesResult => ({
  action: 'generate',
  ok: true,
  modelKey: 'k',
  headers: new Headers(),
  events: (async function* () {
    yield eventFrame({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
    } as OpenAIResponsesStreamEvent);
    yield eventFrame({
      type: 'response.output_text.delta',
      sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text,
    } as OpenAIResponsesStreamEvent);
    yield eventFrame({ type: 'response.completed', sequence_number: 3, response: openaiResponsesResult(text) } as OpenAIResponsesStreamEvent);
    yield doneFrame();
  })(),
});

/** A refusal, in the words an OpenAI-shaped upstream uses for a turn that will not fit. */
const contextExceeded = async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
  ok: false,
  modelKey: 'k',
  response: Response.json(
    { error: { code: 'context_length_exceeded', type: 'invalid_request_error', message: "This model's maximum context length is 8192 tokens" } },
    { status: 400 },
  ),
});

// ── Running one source protocol's chain ───────────────────────────────────────────────────

const serve = async <Entry extends object, Exit extends object>(
  pipeline: Pipeline<Entry, Exit>,
  facts: Record<string, unknown>,
  attemptPayload: unknown,
) => {
  const gateway = mockChatGatewayCtx({ wantsStream: false });
  return await run(pipeline, move(facts) as never, {
    gateway,
    background: () => {},
    rememberCandidates: () => {},
    rememberChatSelection: () => {},
    chatPayloadFor: () => attemptPayload,
    selectAffinity: (selected: ModelCandidate) => { gateway.affinity.select(selected); },
    resolveAttempt: (selector: { readonly upstreamId: string }) => {
      const found = live.find(c => c.provider.upstreamId === selector.upstreamId);
      if (found === undefined) throw new Error(`no live candidate for ${selector.upstreamId}`);
      return found;
    },
  } as never);
};

const openaiChatCompletionsPayload = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] } as unknown as OpenAIChatCompletionsPayload;
const anthropicMessagesPayload = { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] } as unknown as AnthropicMessagesPayload;
const openaiResponsesPayload = { model: MODEL, input: [{ type: 'message', role: 'user', content: 'hi' }] } as unknown as CanonicalOpenAIResponsesPayload;
const geminiGenerateContentPayload = { contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }] } satisfies GeminiGenerateContentPayload;

const serveOpenAIChatCompletions = async (payload: OpenAIChatCompletionsPayload = openaiChatCompletionsPayload) =>
  await serve(openaiChatCompletionsServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'openaiChatCompletions',
    'ingress.chat.openaiChatCompletions.wantsStream': false,
    'ingress.chat.openaiChatCompletions.wantsUsageChunk': false,
    'request.chat.openaiChatCompletions': payload,
    'serve.model': MODEL,
  }, payload);

const serveAnthropicMessages = async (payload: AnthropicMessagesPayload = anthropicMessagesPayload) =>
  await serve(anthropicMessagesServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'anthropicMessages',
    'ingress.chat.anthropicMessages.wantsStream': false,
    'request.chat.anthropicMessages': payload,
    'serve.model': MODEL,
  }, payload);

const serveOpenAIResponses = async (payload: CanonicalOpenAIResponsesPayload = openaiResponsesPayload) =>
  await serve(openaiResponsesServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'openaiResponses',
    'ingress.chat.openaiResponses.wantsStream': false,
    'request.chat.openaiResponses': payload,
    'serve.model': MODEL,
  }, payload);

const serveGeminiGenerateContent = async (payload: GeminiGenerateContentPayload = geminiGenerateContentPayload) =>
  await serve(geminiGenerateContentServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'geminiGenerateContent',
    'ingress.chat.geminiGenerateContent.wantsStream': false,
    'request.chat.geminiGenerateContent': payload,
    'serve.model': MODEL,
  }, payload);

// ── What the client was answered with, per protocol ───────────────────────────────────────

const openaiChatCompletionsText = (rendered: unknown): string | null | undefined =>
  (rendered as OpenAIChatCompletionsResult).choices[0]?.message.content as string | null | undefined;

/** The answer's own text, past the carrier the edge writes back: on this protocol the turn's
 *  state rides as a redacted-thinking block at the head of the content. */
const anthropicMessagesText = (rendered: unknown): string | undefined => {
  const block = (rendered as AnthropicMessagesResult).content.find(part => part.type === 'text');
  return block?.type === 'text' ? block.text : undefined;
};

const openaiResponsesText = (rendered: unknown): string | undefined => {
  const item = (rendered as OpenAIResponsesResult).output.find(output => output.type === 'message');
  const part = item?.type === 'message' ? item.content[0] : undefined;
  return part?.type === 'output_text' ? part.text : undefined;
};

const geminiGenerateContentText = (rendered: unknown): string | undefined =>
  (rendered as GeminiGenerateContentResult).candidates?.[0]?.content.parts.map(part => part.text ?? '').join('');

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('a chat family reaching a candidate over another protocol', () => {
  it('serves /v1/chat/completions on an Anthropic Messages-only candidate', async () => {
    const callAnthropicMessages = vi.fn(async () => anthropicMessagesTurn('hello'));
    resolves([candidate('up_a', { anthropicMessages: {} }, { callAnthropicMessages })]);

    const { facts, drain } = await serveOpenAIChatCompletions();

    expect(callAnthropicMessages).toHaveBeenCalledTimes(1);
    expect(facts['response.http.status']).toBe(200);
    expect(openaiChatCompletionsText(facts['response.chat.openaiChatCompletions.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/chat/completions on an OpenAI Responses-only candidate', async () => {
    const callOpenAIResponses = vi.fn(async () => openaiResponsesTurn('hello'));
    resolves([candidate('up_a', { openaiResponses: {} }, { callOpenAIResponses })]);

    const { facts, drain } = await serveOpenAIChatCompletions();

    expect(callOpenAIResponses).toHaveBeenCalledTimes(1);
    expect(openaiChatCompletionsText(facts['response.chat.openaiChatCompletions.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/messages on an OpenAI Responses-only candidate', async () => {
    const callOpenAIResponses = vi.fn(async () => openaiResponsesTurn('hello'));
    resolves([candidate('up_a', { openaiResponses: {} }, { callOpenAIResponses })]);

    const { facts, drain } = await serveAnthropicMessages();

    expect(callOpenAIResponses).toHaveBeenCalledTimes(1);
    expect(anthropicMessagesText(facts['response.chat.anthropicMessages.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/messages on an OpenAI Chat Completions-only candidate', async () => {
    const callOpenAIChatCompletions = vi.fn(async () => openaiChatCompletionsTurn('hello'));
    resolves([candidate('up_a', { openaiChatCompletions: {} }, { callOpenAIChatCompletions })]);

    const { facts, drain } = await serveAnthropicMessages();

    expect(callOpenAIChatCompletions).toHaveBeenCalledTimes(1);
    expect(anthropicMessagesText(facts['response.chat.anthropicMessages.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/responses on an Anthropic Messages-only candidate', async () => {
    const callAnthropicMessages = vi.fn(async () => anthropicMessagesTurn('hello'));
    resolves([candidate('up_a', { anthropicMessages: {} }, { callAnthropicMessages })]);

    const { facts, drain } = await serveOpenAIResponses();

    expect(callAnthropicMessages).toHaveBeenCalledTimes(1);
    expect(openaiResponsesText(facts['response.chat.openaiResponses.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/responses on an OpenAI Chat Completions-only candidate', async () => {
    const callOpenAIChatCompletions = vi.fn(async () => openaiChatCompletionsTurn('hello'));
    resolves([candidate('up_a', { openaiChatCompletions: {} }, { callOpenAIChatCompletions })]);

    const { facts, drain } = await serveOpenAIResponses();

    expect(callOpenAIChatCompletions).toHaveBeenCalledTimes(1);
    expect(openaiResponsesText(facts['response.chat.openaiResponses.rendered'])).toBe('hello');
    await drain();
  });

  // Gemini generateContent has no wire of its own, so all three of its rows are translated ones.
  it('serves :generateContent on an OpenAI Chat Completions-only candidate', async () => {
    const callOpenAIChatCompletions = vi.fn(async () => openaiChatCompletionsTurn('hello'));
    resolves([candidate('up_a', { openaiChatCompletions: {} }, { callOpenAIChatCompletions })]);

    const { facts, drain } = await serveGeminiGenerateContent();

    expect(callOpenAIChatCompletions).toHaveBeenCalledTimes(1);
    expect(geminiGenerateContentText(facts['response.chat.geminiGenerateContent.rendered'])).toBe('hello');
    await drain();
  });

  it('serves :generateContent on an Anthropic Messages-only candidate', async () => {
    const callAnthropicMessages = vi.fn(async () => anthropicMessagesTurn('hello'));
    resolves([candidate('up_a', { anthropicMessages: {} }, { callAnthropicMessages })]);

    const { facts, drain } = await serveGeminiGenerateContent();

    expect(callAnthropicMessages).toHaveBeenCalledTimes(1);
    expect(geminiGenerateContentText(facts['response.chat.geminiGenerateContent.rendered'])).toBe('hello');
    await drain();
  });

  it('serves :generateContent on an OpenAI Responses-only candidate', async () => {
    const callOpenAIResponses = vi.fn(async () => openaiResponsesTurn('hello'));
    resolves([candidate('up_a', { openaiResponses: {} }, { callOpenAIResponses })]);

    const { facts, drain } = await serveGeminiGenerateContent();

    expect(callOpenAIResponses).toHaveBeenCalledTimes(1);
    expect(geminiGenerateContentText(facts['response.chat.geminiGenerateContent.rendered'])).toBe('hello');
    await drain();
  });
});

describe('the fork over wires', () => {
  // Failover is an ordinary middle stage: what it re-runs is the whole suffix including the
  // stage that picks the wire, so the next candidate re-picks. Nothing here is a mechanism of
  // failover's own — the first candidate goes native and the second goes translated because
  // that is what each one's own endpoints say.
  it('moves from a refused native wire onto a translated one', async () => {
    const callOpenAIChatCompletions = vi.fn(async () => ({
      ok: false as const, modelKey: 'k', response: Response.json({ error: { message: 'slow down' } }, { status: 429 }),
    }));
    const callAnthropicMessages = vi.fn(async () => anthropicMessagesTurn('second'));
    resolves([
      candidate('up_a', { openaiChatCompletions: {} }, { callOpenAIChatCompletions }),
      candidate('up_b', { anthropicMessages: {} }, { callAnthropicMessages }),
    ]);

    const { facts, drain } = await serveOpenAIChatCompletions();

    expect(callOpenAIChatCompletions).toHaveBeenCalledTimes(1);
    expect(callAnthropicMessages).toHaveBeenCalledTimes(1);
    expect(facts['response.http.status']).toBe(200);
    expect(openaiChatCompletionsText(facts['response.chat.openaiChatCompletions.rendered'])).toBe('second');
    await drain();
  });

  // The canonical rewrite: Claude Code reads Anthropic's `prompt is too long:` shape to know
  // it must auto-compact, and an OpenAI-shaped upstream states the same condition in its own
  // words. The pair owns the translation of that refusal, and the handoff is what asks it.
  it('rewrites a context-window refusal into the pair-s own envelope', async () => {
    resolves([candidate('up_a', { openaiChatCompletions: {} }, { callOpenAIChatCompletions: contextExceeded })]);

    const { facts, drain } = await serveAnthropicMessages();

    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.chat.anthropicMessages.rendered']).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE },
    });
    await drain();
  });

  // A refusal a pair says nothing about keeps the status the upstream sent and loses the
  // envelope it came in. The object was the *target* protocol's — an OpenAI `{error:{message}}`
  // reaching a client that reads Anthropic — and answering one protocol in another's words is
  // what the pair exists to prevent. What crosses is the status and the sentence; the client's
  // own edge writes the shape.
  it('carries a refusal the pair does not speak about without its foreign envelope', async () => {
    const callOpenAIChatCompletions = vi.fn(async () => ({
      ok: false as const, modelKey: 'k', response: Response.json({ error: { message: 'no' } }, { status: 403 }),
    }));
    resolves([candidate('up_a', { openaiChatCompletions: {} }, { callOpenAIChatCompletions })]);

    const { facts, drain } = await serveAnthropicMessages();

    expect(facts['response.http.status']).toBe(403);
    const rendered = facts['response.chat.anthropicMessages.rendered'] as { type: string; error: { type: string; message: string } };
    expect(rendered.type).toBe('error');
    expect(rendered.error.type).toBe('permission_error');
    // The upstream's own words survive as the sentence, which is what the replaced surface did
    // with a body it could not forward.
    expect(rendered.error.message).toContain('no');
    await drain();
  });

  // The other half of the same rule: a rule that *can* speak carries the object across, because
  // by then it is in the client's own protocol.
  it('carries the envelope a pair did rewrite', async () => {
    resolves([candidate('up_a', { openaiChatCompletions: {} }, { callOpenAIChatCompletions: contextExceeded })]);

    const { facts, drain } = await serveAnthropicMessages();

    expect(facts['response.chat.anthropicMessages.rendered']).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE },
    });
    await drain();
  });
});

describe('a rule that speaks about one protocol-s wire', () => {
  // The Anthropic Messages fold rewrites *every* inline system message, because Anthropic's top-level
  // `system` is the only first-position slot there. The OpenAI Chat Completions fold rewrites only a
  // system message past the leading run. So a leading system message tells the two apart: a
  // turn that left for OpenAI Chat Completions must be folded by the OpenAI Chat Completions rule, which
  // leaves it alone, and not by the Anthropic Messages one, which would not.
  it('does not run on a turn that leaves for another protocol', async () => {
    let sent: { messages: { role: string }[] } | undefined;
    const payload = {
      model: MODEL,
      max_tokens: 64,
      messages: [{ role: 'system', content: 'lead' }, { role: 'user', content: 'hi' }],
    } as unknown as AnthropicMessagesPayload;
    resolves([candidate(
      'up_a',
      { openaiChatCompletions: {} },
      {
        callOpenAIChatCompletions: async (_model, body) => {
          sent = body as { messages: { role: string }[] };
          return openaiChatCompletionsTurn('hello');
        },
      },
      ['rewrite-mid-conv-system-to-user'],
    )]);

    const { drain } = await serveAnthropicMessages(payload);

    expect(sent?.messages.map(message => message.role)).toEqual(['system', 'user']);
    await drain();
  });

  // The other direction, and the one that pays for the whole arrangement: the usage chunk is
  // asked for by the OpenAI Chat Completions wire, so an Anthropic Messages turn that reaches an upstream over
  // that endpoint is metered like any other turn on it. A rule left in the OpenAI Chat Completions
  // *source* chain would ask for nothing here, and this turn would bill zero.
  it('asks for the usage chunk on a turn that arrived from another protocol', async () => {
    let sent: { stream_options?: unknown } | undefined;
    resolves([candidate('up_a', { openaiChatCompletions: {} }, {
      callOpenAIChatCompletions: async (_model, body) => {
        sent = body as { stream_options?: unknown };
        return openaiChatCompletionsTurn('hello');
      },
    })]);

    const { drain } = await serveAnthropicMessages();

    expect(sent?.stream_options).toEqual({ include_usage: true });
    await drain();
  });

  // The same arrangement for a rule no guard ever covered. The old surface ran the *whole*
  // target array on a translated body, so a turn arriving over a translation was shaped for
  // the wire it landed on. A rule left in the Anthropic Messages source chain would scrub nothing here.
  it('applies the target wire-s unguarded rules to a turn that arrived translated', async () => {
    let sent: { system?: unknown } | undefined;
    resolves([candidate('up_a', { anthropicMessages: {} }, {
      callAnthropicMessages: async (_model, body) => {
        sent = body as { system?: unknown };
        return anthropicMessagesTurn('hello');
      },
    }, ['strip-billing-attribution'])]);

    const { drain } = await serveOpenAIChatCompletions({
      ...openaiChatCompletionsPayload,
      messages: [
        { role: 'system', content: 'be brief\nx-anthropic-billing-header: acct-42' },
        { role: 'user', content: 'hi' },
      ],
    } as OpenAIChatCompletionsPayload);

    expect(String(JSON.stringify(sent?.system))).not.toContain('x-anthropic-billing-header');
    await drain();
  });

  // And a rule the *other* wire owns stays off this turn. `stream_options` is an OpenAI Chat
  // Completions field, so an OpenAI Chat Completions turn dialled over Anthropic Messages must
  // not carry it —
  // which is what the replaced surface said with a target-API guard and
  // what position says here.
  it('does not carry another wire-s request rules onto the wire it dialled', async () => {
    let sent: Record<string, unknown> | undefined;
    resolves([candidate('up_a', { anthropicMessages: {} }, {
      callAnthropicMessages: async (_model, body) => {
        sent = body as Record<string, unknown>;
        return anthropicMessagesTurn('hello');
      },
    })]);

    const { drain } = await serveOpenAIChatCompletions();

    expect(sent).toBeDefined();
    expect('stream_options' in sent!).toBe(false);
    await drain();
  });

  // The other half, and this one assembly says rather than a run: the wire's own rules read
  // the wire's own request key, so `compose` refuses to place them *below* a handoff that has
  // taken it. It is one array's arrangement and not a proof — `compose` walks one array, and
  // the same rule left above the fork is invisible to it. What keeps a wire's rule off a
  // translated turn is that the rule lives in the wire's own chain.
  it('cannot be placed in a chain whose payload a handoff consumed', () => {
    const leaving = handOff({
      from: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
      to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
      trip: () => { throw new Error('not dialled'); },
    });
    const arriving = handOff({
      from: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
      to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
      trip: () => { throw new Error('not dialled'); },
    });

    expect(() => compose('leaving', [leaving, ...anthropicMessagesWire('r')]))
      .toThrow(/needs request\.chat\.anthropicMessages, which handOff:.* consumed above it/);
    expect(() => compose('arriving', [arriving, ...anthropicMessagesWire('r')])).not.toThrow();
  });
});
