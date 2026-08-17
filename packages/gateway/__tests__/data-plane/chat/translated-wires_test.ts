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
// run on a turn that leaves for another — which is what the interceptor form said with
// `ctx.targetApi !== <self>` and what position says here.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatCompletionsServePipeline } from '../../../src/data-plane/chat/chat-completions/pipeline.ts';
import { geminiServePipeline } from '../../../src/data-plane/chat/gemini/pipeline.ts';
import { handOff } from '../../../src/data-plane/chat/handoff.ts';
import { messagesServePipeline, messagesWire } from '../../../src/data-plane/chat/messages/pipeline.ts';
import { responsesServePipeline } from '../../../src/data-plane/chat/responses/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, move, run, type Pipeline } from '@floway-dev/pipeline';
import type { ChatCompletionsPayload, ChatCompletionsResult, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiResult } from '@floway-dev/protocols/gemini';
import { PROMPT_TOO_LONG_MESSAGE, type MessagesPayload, type MessagesResult, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { CanonicalResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { directFetcher, type FlagId, type ModelCandidate, type ProviderResponsesResult, type ProviderStreamResult } from '@floway-dev/provider';
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
  readonly callChatCompletions?: (model: unknown, body: unknown) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  readonly callMessages?: (model: unknown, body: unknown) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  readonly callResponses?: (model: unknown, body: unknown) => Promise<ProviderResponsesResult>;
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

const chatCompletionsTurn = (text: string): ProviderStreamResult<ChatCompletionsStreamEvent> => ({
  ok: true,
  modelKey: 'k',
  headers: new Headers(),
  events: (async function* () {
    yield eventFrame({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    } as ChatCompletionsStreamEvent);
    yield eventFrame({
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    } as ChatCompletionsStreamEvent);
    yield doneFrame();
  })(),
});

const messagesTurn = (text: string): ProviderStreamResult<MessagesStreamEvent> => ({
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
    } as MessagesStreamEvent);
    yield eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as MessagesStreamEvent);
    yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } as MessagesStreamEvent);
    yield eventFrame({ type: 'content_block_stop', index: 0 } as MessagesStreamEvent);
    yield eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } as MessagesStreamEvent);
    yield eventFrame({ type: 'message_stop' } as MessagesStreamEvent);
    yield doneFrame();
  })(),
});

const responsesResult = (text: string): ResponsesResult => ({
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

const responsesTurn = (text: string): ProviderResponsesResult => ({
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
    } as ResponsesStreamEvent);
    yield eventFrame({
      type: 'response.output_text.delta',
      sequence_number: 2, item_id: 'msg_1', output_index: 0, content_index: 0, delta: text,
    } as ResponsesStreamEvent);
    yield eventFrame({ type: 'response.completed', sequence_number: 3, response: responsesResult(text) } as ResponsesStreamEvent);
    yield doneFrame();
  })(),
});

/** A refusal, in the words an OpenAI-shaped upstream uses for a turn that will not fit. */
const contextExceeded = async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
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

const chatCompletionsPayload = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] } as unknown as ChatCompletionsPayload;
const messagesPayload = { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] } as unknown as MessagesPayload;
const responsesPayload = { model: MODEL, input: [{ type: 'message', role: 'user', content: 'hi' }] } as unknown as CanonicalResponsesPayload;
const geminiPayload = { contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }] } satisfies GeminiPayload;

const serveChatCompletions = async (payload: ChatCompletionsPayload = chatCompletionsPayload) =>
  await serve(chatCompletionsServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'chatCompletions',
    'ingress.chat.chatCompletions.wantsStream': false,
    'ingress.chat.chatCompletions.wantsUsageChunk': false,
    'request.chat.chatCompletions': payload,
    'serve.model': MODEL,
  }, payload);

const serveMessages = async (payload: MessagesPayload = messagesPayload) =>
  await serve(messagesServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'messages',
    'ingress.chat.messages.wantsStream': false,
    'request.chat.messages': payload,
    'serve.model': MODEL,
  }, payload);

const serveResponses = async (payload: CanonicalResponsesPayload = responsesPayload) =>
  await serve(responsesServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'responses',
    'ingress.chat.responses.wantsStream': false,
    'request.chat.responses': payload,
    'serve.model': MODEL,
  }, payload);

const serveGemini = async (payload: GeminiPayload = geminiPayload) =>
  await serve(geminiServePipeline(payload), {
    'ingress.http.headers': [],
    'ingress.chat.sourceProtocol': 'gemini',
    'ingress.chat.gemini.wantsStream': false,
    'request.chat.gemini': payload,
    'serve.model': MODEL,
  }, payload);

// ── What the client was answered with, per protocol ───────────────────────────────────────

const chatCompletionsText = (rendered: unknown): string | null | undefined =>
  (rendered as ChatCompletionsResult).choices[0]?.message.content as string | null | undefined;

/** The answer's own text, past the carrier the edge writes back: on this protocol the turn's
 *  state rides as a redacted-thinking block at the head of the content. */
const messagesText = (rendered: unknown): string | undefined => {
  const block = (rendered as MessagesResult).content.find(part => part.type === 'text');
  return block?.type === 'text' ? block.text : undefined;
};

const responsesText = (rendered: unknown): string | undefined => {
  const item = (rendered as ResponsesResult).output.find(output => output.type === 'message');
  const part = item?.type === 'message' ? item.content[0] : undefined;
  return part?.type === 'output_text' ? part.text : undefined;
};

const geminiText = (rendered: unknown): string | undefined =>
  (rendered as GeminiResult).candidates?.[0]?.content.parts.map(part => part.text ?? '').join('');

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('a chat family reaching a candidate over another protocol', () => {
  it('serves /v1/chat/completions on a Messages-only candidate', async () => {
    const callMessages = vi.fn(async () => messagesTurn('hello'));
    resolves([candidate('up_a', { messages: {} }, { callMessages })]);

    const { facts, drain } = await serveChatCompletions();

    expect(callMessages).toHaveBeenCalledTimes(1);
    expect(facts['response.http.status']).toBe(200);
    expect(chatCompletionsText(facts['response.chat.chatCompletions.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/chat/completions on a Responses-only candidate', async () => {
    const callResponses = vi.fn(async () => responsesTurn('hello'));
    resolves([candidate('up_a', { responses: {} }, { callResponses })]);

    const { facts, drain } = await serveChatCompletions();

    expect(callResponses).toHaveBeenCalledTimes(1);
    expect(chatCompletionsText(facts['response.chat.chatCompletions.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/messages on a Responses-only candidate', async () => {
    const callResponses = vi.fn(async () => responsesTurn('hello'));
    resolves([candidate('up_a', { responses: {} }, { callResponses })]);

    const { facts, drain } = await serveMessages();

    expect(callResponses).toHaveBeenCalledTimes(1);
    expect(messagesText(facts['response.chat.messages.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/messages on a Chat Completions-only candidate', async () => {
    const callChatCompletions = vi.fn(async () => chatCompletionsTurn('hello'));
    resolves([candidate('up_a', { chatCompletions: {} }, { callChatCompletions })]);

    const { facts, drain } = await serveMessages();

    expect(callChatCompletions).toHaveBeenCalledTimes(1);
    expect(messagesText(facts['response.chat.messages.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/responses on a Messages-only candidate', async () => {
    const callMessages = vi.fn(async () => messagesTurn('hello'));
    resolves([candidate('up_a', { messages: {} }, { callMessages })]);

    const { facts, drain } = await serveResponses();

    expect(callMessages).toHaveBeenCalledTimes(1);
    expect(responsesText(facts['response.chat.responses.rendered'])).toBe('hello');
    await drain();
  });

  it('serves /v1/responses on a Chat Completions-only candidate', async () => {
    const callChatCompletions = vi.fn(async () => chatCompletionsTurn('hello'));
    resolves([candidate('up_a', { chatCompletions: {} }, { callChatCompletions })]);

    const { facts, drain } = await serveResponses();

    expect(callChatCompletions).toHaveBeenCalledTimes(1);
    expect(responsesText(facts['response.chat.responses.rendered'])).toBe('hello');
    await drain();
  });

  // Gemini has no wire of its own, so all three of its rows are translated ones.
  it('serves :generateContent on a Chat Completions-only candidate', async () => {
    const callChatCompletions = vi.fn(async () => chatCompletionsTurn('hello'));
    resolves([candidate('up_a', { chatCompletions: {} }, { callChatCompletions })]);

    const { facts, drain } = await serveGemini();

    expect(callChatCompletions).toHaveBeenCalledTimes(1);
    expect(geminiText(facts['response.chat.gemini.rendered'])).toBe('hello');
    await drain();
  });

  it('serves :generateContent on a Messages-only candidate', async () => {
    const callMessages = vi.fn(async () => messagesTurn('hello'));
    resolves([candidate('up_a', { messages: {} }, { callMessages })]);

    const { facts, drain } = await serveGemini();

    expect(callMessages).toHaveBeenCalledTimes(1);
    expect(geminiText(facts['response.chat.gemini.rendered'])).toBe('hello');
    await drain();
  });

  it('serves :generateContent on a Responses-only candidate', async () => {
    const callResponses = vi.fn(async () => responsesTurn('hello'));
    resolves([candidate('up_a', { responses: {} }, { callResponses })]);

    const { facts, drain } = await serveGemini();

    expect(callResponses).toHaveBeenCalledTimes(1);
    expect(geminiText(facts['response.chat.gemini.rendered'])).toBe('hello');
    await drain();
  });
});

describe('the fork over wires', () => {
  // Failover is an ordinary middle stage: what it re-runs is the whole suffix including the
  // stage that picks the wire, so the next candidate re-picks. Nothing here is a mechanism of
  // failover's own — the first candidate goes native and the second goes translated because
  // that is what each one's own endpoints say.
  it('moves from a refused native wire onto a translated one', async () => {
    const callChatCompletions = vi.fn(async () => ({
      ok: false as const, modelKey: 'k', response: Response.json({ error: { message: 'slow down' } }, { status: 429 }),
    }));
    const callMessages = vi.fn(async () => messagesTurn('second'));
    resolves([
      candidate('up_a', { chatCompletions: {} }, { callChatCompletions }),
      candidate('up_b', { messages: {} }, { callMessages }),
    ]);

    const { facts, drain } = await serveChatCompletions();

    expect(callChatCompletions).toHaveBeenCalledTimes(1);
    expect(callMessages).toHaveBeenCalledTimes(1);
    expect(facts['response.http.status']).toBe(200);
    expect(chatCompletionsText(facts['response.chat.chatCompletions.rendered'])).toBe('second');
    await drain();
  });

  // The canonical rewrite: Claude Code reads Anthropic's `prompt is too long:` shape to know
  // it must auto-compact, and an OpenAI-shaped upstream states the same condition in its own
  // words. The pair owns the translation of that refusal, and the handoff is what asks it.
  it('rewrites a context-window refusal into the pair-s own envelope', async () => {
    resolves([candidate('up_a', { chatCompletions: {} }, { callChatCompletions: contextExceeded })]);

    const { facts, drain } = await serveMessages();

    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.chat.messages.rendered']).toEqual({
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
    const callChatCompletions = vi.fn(async () => ({
      ok: false as const, modelKey: 'k', response: Response.json({ error: { message: 'no' } }, { status: 403 }),
    }));
    resolves([candidate('up_a', { chatCompletions: {} }, { callChatCompletions })]);

    const { facts, drain } = await serveMessages();

    expect(facts['response.http.status']).toBe(403);
    const rendered = facts['response.chat.messages.rendered'] as { type: string; error: { type: string; message: string } };
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
    resolves([candidate('up_a', { chatCompletions: {} }, { callChatCompletions: contextExceeded })]);

    const { facts, drain } = await serveMessages();

    expect(facts['response.chat.messages.rendered']).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE },
    });
    await drain();
  });
});

describe('a rule that speaks about one protocol-s wire', () => {
  // The Messages fold rewrites *every* inline system message, because Anthropic's top-level
  // `system` is the only first-position slot there. The Chat Completions fold rewrites only a
  // system message past the leading run. So a leading system message tells the two apart: a
  // turn that left for Chat Completions must be folded by the Chat Completions rule, which
  // leaves it alone, and not by the Messages one, which would not.
  it('does not run on a turn that leaves for another protocol', async () => {
    let sent: { messages: { role: string }[] } | undefined;
    const payload = {
      model: MODEL,
      max_tokens: 64,
      messages: [{ role: 'system', content: 'lead' }, { role: 'user', content: 'hi' }],
    } as unknown as MessagesPayload;
    resolves([candidate(
      'up_a',
      { chatCompletions: {} },
      {
        callChatCompletions: async (_model, body) => {
          sent = body as { messages: { role: string }[] };
          return chatCompletionsTurn('hello');
        },
      },
      ['rewrite-mid-conv-system-to-user'],
    )]);

    const { drain } = await serveMessages(payload);

    expect(sent?.messages.map(message => message.role)).toEqual(['system', 'user']);
    await drain();
  });

  // The other direction, and the one that pays for the whole arrangement: the usage chunk is
  // asked for by the Chat Completions wire, so a Messages turn that reaches an upstream over
  // that endpoint is metered like any other turn on it. A rule left in the Chat Completions
  // *source* chain would ask for nothing here, and this turn would bill zero.
  it('asks for the usage chunk on a turn that arrived from another protocol', async () => {
    let sent: { stream_options?: unknown } | undefined;
    resolves([candidate('up_a', { chatCompletions: {} }, {
      callChatCompletions: async (_model, body) => {
        sent = body as { stream_options?: unknown };
        return chatCompletionsTurn('hello');
      },
    })]);

    const { drain } = await serveMessages();

    expect(sent?.stream_options).toEqual({ include_usage: true });
    await drain();
  });

  // The same arrangement for a rule no guard ever covered. The old surface ran the *whole*
  // target array on a translated body, so a turn arriving over a translation was shaped for
  // the wire it landed on. A rule left in the Messages source chain would scrub nothing here.
  it('applies the target wire-s unguarded rules to a turn that arrived translated', async () => {
    let sent: { system?: unknown } | undefined;
    resolves([candidate('up_a', { messages: {} }, {
      callMessages: async (_model, body) => {
        sent = body as { system?: unknown };
        return messagesTurn('hello');
      },
    }, ['strip-billing-attribution'])]);

    const { drain } = await serveChatCompletions({
      ...chatCompletionsPayload,
      messages: [
        { role: 'system', content: 'be brief\nx-anthropic-billing-header: acct-42' },
        { role: 'user', content: 'hi' },
      ],
    } as ChatCompletionsPayload);

    expect(String(JSON.stringify(sent?.system))).not.toContain('x-anthropic-billing-header');
    await drain();
  });

  // And a rule the *other* wire owns stays off this turn. `stream_options` is a Chat
  // Completions field, so a Chat Completions turn dialled over Messages must not carry it —
  // which is what the interceptor form said with `ctx.targetApi !== 'chat-completions'` and
  // what position says here.
  it('does not carry another wire-s request rules onto the wire it dialled', async () => {
    let sent: Record<string, unknown> | undefined;
    resolves([candidate('up_a', { messages: {} }, {
      callMessages: async (_model, body) => {
        sent = body as Record<string, unknown>;
        return messagesTurn('hello');
      },
    })]);

    const { drain } = await serveChatCompletions();

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
      from: { request: 'request.chat.messages', response: 'response.chat.messages' },
      to: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
      trip: () => { throw new Error('not dialled'); },
    });
    const arriving = handOff({
      from: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
      to: { request: 'request.chat.messages', response: 'response.chat.messages' },
      trip: () => { throw new Error('not dialled'); },
    });

    expect(() => compose('leaving', [leaving, ...messagesWire('r')]))
      .toThrow(/needs request\.chat\.messages, which handOff:.* consumed above it/);
    expect(() => compose('arriving', [arriving, ...messagesWire('r')])).not.toThrow();
  });
});
