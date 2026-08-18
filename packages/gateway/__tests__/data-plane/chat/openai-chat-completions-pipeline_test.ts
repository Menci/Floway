// The OpenAI Chat Completions chain, run. Assembly is checked where every family's is; what is
// written down here is what only running it can say — that the edge folds a stream into one
// object when the client did not ask to stream, that it hands the turn's own state back for
// the client to carry, that a refusal keeps the upstream's own status and words, and that a
// dial nobody answered is a value the fork can move past.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openaiChatCompletionsServePipeline } from '../../../src/data-plane/chat/openai-chat-completions/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import { OPENAI_CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE, type OpenAIChatCompletionsPayload, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { SseFrame } from '@floway-dev/protocols/common';
import { directFetcher, type FlagId, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

const candidate = (
  callOpenAIChatCompletions: (model: unknown, body: unknown) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>,
  upstreamId = 'up_a',
  flags: readonly FlagId[] = [],
): ModelCandidate => {
  const endpoints = { openaiChatCompletions: {} };
  return {
    provider: {
      upstreamId, kind: 'custom', name: upstreamId, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callOpenAIChatCompletions }),
    },
    model: stubInternalModel(
      {
        id: 'chat-model',
        endpoints,
        providerModels: { [upstreamId]: stubProviderModel({ id: 'chat-model', endpoints, enabledFlags: new Set(flags) }) },
      },
      upstreamId,
    ),
    fetcher: directFetcher,
  } as unknown as ModelCandidate;
};

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] } as never);
};

const chunk = (text: string): OpenAIChatCompletionsStreamEvent => ({
  id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'chat-model',
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
});

/** What this frame carries of the turn's own state, if it is the carrier the edge writes: a
 *  chunk whose delta holds nothing but `reasoning_opaque`. */
const affinityCarrier = (frame: SseFrame): string | undefined => {
  if (frame.data === '[DONE]') return undefined;
  return (JSON.parse(frame.data) as OpenAIChatCompletionsStreamEvent).choices[0]?.delta.reasoning_opaque ?? undefined;
};

/** A stream that stops without ever saying it ended — what a dropped upstream looks like. */
const truncated = (...events: readonly OpenAIChatCompletionsStreamEvent[]): ProviderStreamResult<OpenAIChatCompletionsStreamEvent> => ({
  ok: true,
  modelKey: 'chat-model-key',
  headers: new Headers(),
  events: (async function* () {
    for (const event of events) yield { type: 'event' as const, event };
  })(),
});

const stream = (...events: readonly OpenAIChatCompletionsStreamEvent[]): ProviderStreamResult<OpenAIChatCompletionsStreamEvent> => ({
  ok: true,
  modelKey: 'chat-model-key',
  headers: new Headers({ 'x-request-id': 'req-1', 'content-length': '99' }),
  events: (async function* () {
    for (const event of events) yield { type: 'event' as const, event };
    yield { type: 'done' as const };
  })(),
});

const payload = { model: 'chat-model', messages: [{ role: 'user', content: 'hi' }] } as unknown as OpenAIChatCompletionsPayload;

/** What affinity materialized for the candidate about to be dialled. It differs from the
 *  payload the client sent, which is the point: carried state is rewritten per candidate. */
let affinityPayload: OpenAIChatCompletionsPayload = payload;

const serve = async (wantsStream: boolean) => await serveWith(mockChatGatewayCtx({ wantsStream }), wantsStream);

const serveWith = async (
  gateway: ReturnType<typeof mockChatGatewayCtx>,
  wantsStream: boolean,
  wantsUsageChunk = false,
) => await run(
  openaiChatCompletionsServePipeline(payload),
  move({
    'ingress.http.headers': [] as readonly (readonly [string, string])[],
    'ingress.chat.sourceProtocol': 'openaiChatCompletions',
    'ingress.chat.openaiChatCompletions.wantsStream': wantsStream,
    'ingress.chat.openaiChatCompletions.wantsUsageChunk': wantsUsageChunk,
    'request.chat.openaiChatCompletions': payload,
    'serve.model': 'chat-model',
  }) as never,
  {
    gateway,
    background: () => {},
    rememberCandidates: () => {},
    rememberChatSelection: () => {},
    chatPayloadFor: () => affinityPayload,
    // Wired where the app wires it: the carrier the edge writes is addressed to whatever the
    // chain named here.
    selectAffinity: (selected: ModelCandidate) => { gateway.affinity.select(selected); },
    resolveAttempt: (selector: { readonly upstreamId: string }) => {
      const found = live.find(c => c.provider.upstreamId === selector.upstreamId);
      if (found === undefined) throw new Error(`no live candidate for ${selector.upstreamId}`);
      return found;
    },
  } as never,
);

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('the chat completions chain', () => {
  // The interceptors rewrite the request as a fact, so what they rewrite has to be what the
  // ending sends. An ending that asked the resolver for the payload instead would read one no
  // interceptor had touched, and every rewrite in the chain would go nowhere.
  it('sends what the interceptors rewrote, not what the resolver materialized', async () => {
    let sent: { messages: { role: string }[] } | undefined;
    affinityPayload = {
      ...payload,
      messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
    } as unknown as OpenAIChatCompletionsPayload;
    resolves([candidate(async (_model, body) => {
      sent = body as { messages: { role: string }[] };
      return stream(chunk('hi'));
    }, 'up_a', ['rewrite-system-to-developer'])]);

    await serve(false);

    expect(sent!.messages.map(message => message.role)).toEqual(['developer', 'user']);
    affinityPayload = payload;
  });

  // Affinity rewrites client-carried state for the upstream that will see it, so the body
  // that goes out is the one it materialized rather than the one the client sent.
  it('sends the payload affinity materialized for the candidate it dialled', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = { ...payload, messages: [{ role: 'user', content: 'rewritten' }] } as OpenAIChatCompletionsPayload;
    resolves([candidate(async (_model, body) => {
      sent = body as Record<string, unknown>;
      return stream(chunk('hi'));
    })]);

    await serve(false);

    expect(sent).toMatchObject({ messages: [{ role: 'user', content: 'rewritten' }] });
    expect(sent).not.toHaveProperty('model');
    affinityPayload = payload;
  });

  it('writes the frames out when the client asked to stream', async () => {
    resolves([candidate(async () => stream(chunk('he'), chunk('llo')))]);

    const { facts } = await serve(true);
    const frames: SseFrame[] = [];
    for await (const frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) frames.push(frame);

    expect(facts['response.http.status']).toBe(200);
    // The carrier the edge writes has a test of its own below; what the protocol itself
    // answered with is these frames, in this order.
    expect(frames.filter(frame => affinityCarrier(frame) === undefined).map(frame => frame.data)).toEqual([
      JSON.stringify(chunk('he')),
      JSON.stringify(chunk('llo')),
      '[DONE]',
    ]);
  });

  // The other half of affinity: the resolver reads client-carried state on the way down, and
  // this is what the client is given to carry back. A turn that handed back nothing would
  // leave the follow-up quoting it with no way to name the upstream that issued it.
  it('hands the turn-s own state back on a chunk of its own', async () => {
    resolves([candidate(async () => stream(chunk('hi')))]);
    const gateway = mockChatGatewayCtx({ wantsStream: true });

    const { facts } = await serveWith(gateway, true);
    const frames: SseFrame[] = [];
    for await (const frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) frames.push(frame);
    const carried = frames.flatMap(frame => affinityCarrier(frame) ?? []);

    expect(carried).toHaveLength(1);
    // It names the upstream that answered, sealed under this run's own secret — which is what
    // lets the next turn be pinned to it.
    expect(await gateway.affinity.codec.unwrap(carried[0]!, 'openai-chat-completions.reasoning_opaque')).toMatchObject({
      kind: 'owned',
      affinity: { upstreamId: 'up_a', modelId: 'chat-model' },
    });
  });

  // The upstream speaks SSE whatever the client asked for, so a client that did not ask to
  // stream is answered from the same frames — folded here rather than read a second time.
  it('folds the frames into one object when the client did not', async () => {
    resolves([candidate(async () => stream(chunk('he'), chunk('llo')))]);

    const { facts } = await serve(false);
    const rendered = facts['response.chat.openaiChatCompletions.rendered'] as { choices: { message: { content: string } }[] };

    expect(facts['response.http.status']).toBe(200);
    expect(rendered.choices[0]!.message.content).toBe('hello');
  });

  // Content-length would misdescribe a body this gateway serialized itself; a vendor trace
  // is what a client and an operator both need to correlate a turn.
  it('forwards the upstream headers a client may see and drops the ones it may not', async () => {
    resolves([candidate(async () => stream(chunk('hi')))]);

    const { facts } = await serve(true);

    expect(Object.fromEntries(facts['response.http.headers'])).toMatchObject({ 'x-request-id': 'req-1' });
    expect(Object.fromEntries(facts['response.http.headers'])).not.toHaveProperty('content-length');
  });

  it('answers an upstream refusal with its own status and words', async () => {
    resolves([candidate(async () => ({
      ok: false,
      modelKey: 'chat-model-key',
      response: new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429, headers: { 'content-type': 'application/json' },
      }),
    }))]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(429);
    expect(facts['response.chat.openaiChatCompletions.rendered']).toEqual({ error: { message: 'slow down' } });
  });

  // What the upstream reported is per token category and what is billed is per metric name;
  // the two are not interchangeable, and a cast between them writes a row with no metrics.
  it('bills the metrics the upstream-s own usage adds up to', async () => {
    resolves([candidate(async () => stream(chunk('hi'), {
      id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'chat-model',
      choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
    } as unknown as OpenAIChatCompletionsStreamEvent))]);

    const { facts } = await serve(true);
    for await (const _frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) { /* drain */ }
    const outcome = await facts['response.chat.openaiChatCompletions.streamedUsage']!;

    expect(outcome.billable[0]!.quantities).toMatchObject({ input_tokens: '11', output_tokens: '4' });
    // A rate can depend on the tier and on how much input there was; both are selector
    // coordinates, so they travel as pricing facts rather than as quantities.
    expect(outcome.billable[0]!.pricingFacts).toMatchObject({ inputTokens: 11 });
    // The stream reached its terminator, so the turn produced what it said it would.
    expect(outcome.failed).toBe(false);
  });

  // The test above hands over a usage chunk whatever was asked for, which is a stream no
  // OpenAI-compatible upstream would have sent: the final usage chunk arrives only when
  // `stream_options.include_usage` is on. This upstream behaves like a real one, so what it
  // states is the whole billing path — a chain that stopped asking would meter a stream that
  // reported nothing and bill the turn zero, with nothing else in the suite noticing.
  it('asks the upstream for the usage chunk, and so bills a streaming turn at all', async () => {
    let asked: { include_usage?: boolean } | null | undefined;
    resolves([candidate(async (_model, body) => {
      asked = (body as { stream_options?: { include_usage?: boolean } }).stream_options;
      return asked?.include_usage === true
        ? stream(chunk('hi'), {
            id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'chat-model',
            choices: [], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
          } as unknown as OpenAIChatCompletionsStreamEvent)
        : stream(chunk('hi'));
    })]);

    // The client did not ask to see the chunk, which is the ordinary case and the one where
    // the two questions come apart: the upstream is asked for it regardless.
    const { facts } = await serve(true);
    const frames: SseFrame[] = [];
    for await (const frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) frames.push(frame);
    const outcome = await facts['response.chat.openaiChatCompletions.streamedUsage']!;

    expect(asked).toEqual({ include_usage: true });
    expect(outcome.billable[0]!.quantities).toMatchObject({ input_tokens: '11', output_tokens: '4' });
    // And the client, who asked for none of this, is shown none of it.
    expect(frames.some(frame => frame.data !== '[DONE]' && 'usage' in (JSON.parse(frame.data) as object))).toBe(false);
  });

  // The wire's response-direction rules, on the wire that owns them, in the order it composes
  // them — which is a property of the array in `openaiChatCompletionsWire` and of nothing else. A
  // DeepSeek-shaped upstream reporting the exclusive cache convention exercises all three at
  // once, and each one's input is what the one below it left: the vendor rename, then the fold
  // that reads the renamed field, then the split that puts the settled usage on a carrier.
  it('serves a vendor dialect through the wire-s rules, in the order the wire composes them', async () => {
    resolves([candidate(async () => stream(
      {
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'chat-model',
        choices: [{ index: 0, delta: { reasoning_content: 'pondering' }, finish_reason: null }],
      } as unknown as OpenAIChatCompletionsStreamEvent,
      {
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'chat-model',
        // Hung off the final delta rather than sent on a carrier, in DeepSeek's own cache
        // field names, counting the cached prefix outside the input total: 479 + 13312 + 373
        // is the 14164 it states.
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 479, completion_tokens: 373, total_tokens: 14164,
          prompt_cache_hit_tokens: 13312, prompt_cache_miss_tokens: 479,
        },
      } as unknown as OpenAIChatCompletionsStreamEvent,
    ), 'up_a', ['vendor-deepseek'])]);

    const { facts } = await serveWith(mockChatGatewayCtx({ wantsStream: true }), true, true);
    const written: OpenAIChatCompletionsStreamEvent[] = [];
    for await (const frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) {
      if (frame.data !== '[DONE]' && affinityCarrier(frame) === undefined) {
        written.push(JSON.parse(frame.data) as OpenAIChatCompletionsStreamEvent);
      }
    }

    // The vendor's reasoning field left under the canonical name.
    expect(written[0]!.choices[0]!.delta).toEqual({ reasoning_text: 'pondering' });
    // The generated text is still the client's, whatever the rules did around it.
    expect(written.some(event => event.choices[0]?.delta.content === 'hi')).toBe(true);
    // Exactly one frame carries usage, and it is a carrier rather than a chunk that also
    // carried a delta — which is the split, and it happened once.
    const carriers = written.filter(event => 'usage' in event) as unknown as { choices: unknown[]; usage: Record<string, unknown> }[];
    expect(carriers).toHaveLength(1);
    expect(carriers[0]!.choices).toEqual([]);
    // In OpenAI's names, with the cached prefix folded back into the input total the way
    // OpenAI's contract states it: neither would be true if either rule ran out of turn.
    expect(carriers[0]!.usage).toEqual({
      prompt_tokens: 13791,
      completion_tokens: 373,
      total_tokens: 14164,
      prompt_tokens_details: { cached_tokens: 13312 },
    });
  });

  // The other two dialects the wire composes, each stating it in a different direction: Qwen
  // rewrites the request, Kimi the usage that comes back. The flags are independent, so one
  // candidate carrying both is what runs the pair in one turn — an upstream in the field
  // carries one of them.
  it('serves the request-side and response-side vendor dialects the wire also composes', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = { ...payload, reasoning_effort: 'none' } as OpenAIChatCompletionsPayload;
    resolves([candidate(async (_model, body) => {
      sent = body as Record<string, unknown>;
      return stream(chunk('hi'), {
        id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'chat-model',
        choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 30 },
      } as unknown as OpenAIChatCompletionsStreamEvent);
    }, 'up_a', ['vendor-qwen', 'vendor-kimi'])]);

    const { facts } = await serveWith(mockChatGatewayCtx({ wantsStream: true }), true, true);
    const written: OpenAIChatCompletionsStreamEvent[] = [];
    for await (const frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) {
      if (frame.data !== '[DONE]' && affinityCarrier(frame) === undefined) {
        written.push(JSON.parse(frame.data) as OpenAIChatCompletionsStreamEvent);
      }
    }
    affinityPayload = payload;

    // Qwen's own spelling of "no reasoning" went out on the body this wire sent.
    expect('reasoning_effort' in sent!).toBe(false);
    expect(sent!.enable_thinking).toBe(false);
    // And Kimi's flat cached count came back under the name every rule above it reads. The
    // totals say the cache was counted inside the input here, so nothing is folded.
    const carrier = written.find(event => 'usage' in event) as unknown as { usage: Record<string, unknown> };
    expect(carrier.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 30 },
    });
  });

  // Time to first token is measured where the token is — an envelope frame is not one, and a
  // run that never stamps it is recorded as having produced nothing to time.
  it('stamps the first frame that carried a generated token', async () => {
    resolves([candidate(async () => stream(chunk('hi')))]);
    const gateway = mockChatGatewayCtx({ wantsStream: true });

    const { facts } = await serveWith(gateway, true);
    expect(gateway.attempt.firstOutputTokenAt).toBeNull();
    for await (const _frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) { /* drain */ }

    expect(gateway.attempt.firstOutputTokenAt).toBeTypeOf('number');
  });

  // A refusal the gateway made itself has no upstream body to forward, and that is the one
  // case where the client's own protocol decides the shape. An OpenAI client reads
  // error.type, and `api_error` would say the gateway broke rather than that the request did.
  it('names its own refusal in the type an OpenAI client reads', async () => {
    vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates: [], sawModel: true, failedUpstreams: [] } as never);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.chat.openaiChatCompletions.rendered']).toEqual({
      error: { message: 'Model chat-model does not support the /chat/completions endpoint.', type: 'invalid_request_error' },
    });
  });

  // Serving what arrived would present a truncated answer as a whole one, and a client has no
  // way to tell the difference. The streaming path is where this has to be caught: nothing
  // folds those frames, so the collector's own check never runs on them.
  it('fails a stream that ran out without saying it ended', async () => {
    resolves([candidate(async () => truncated(chunk('he'), chunk('llo')))]);

    const { facts } = await serve(true);
    const drain = async (): Promise<void> => {
      for await (const _frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) { /* to the end */ }
    };

    await expect(drain()).rejects.toThrow(OPENAI_CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
  });

  // Anything an upstream keeps sending after its terminator is not part of the answer.
  it('stops reading at the terminator, and writes it', async () => {
    resolves([candidate(async () => stream(chunk('hi')))]);

    const { facts } = await serve(true);
    const frames: SseFrame[] = [];
    for await (const frame of facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) frames.push(frame);

    expect(frames.at(-1)!.data).toBe('[DONE]');
  });

  // A refused connection is an outcome the fork has to be able to see, not a fault that ends
  // the run — so the second candidate is tried and its answer is the one served.
  it('fails a dial that never connected over to the next candidate', async () => {
    const tried: string[] = [];
    resolves([
      candidate(async () => { tried.push('dead'); throw new Error('ECONNREFUSED'); }, 'up_dead'),
      candidate(async () => { tried.push('alive'); return stream(chunk('hi')); }, 'up_alive'),
    ]);

    const { facts } = await serve(false);

    expect(tried).toEqual(['dead', 'alive']);
    expect(facts['response.http.status']).toBe(200);
  });
});
