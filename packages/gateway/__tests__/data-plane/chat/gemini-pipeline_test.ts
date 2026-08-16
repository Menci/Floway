// Gemini's pipeline, assembled and run. Gemini is the source-only family and the one with no
// wire of its own, so what a run of it has to show beyond the entry contract is the round
// trip: a turn translated out to Chat Completions, an answer translated back, and the reading
// taken on the dialect the upstream actually spoke rather than on the one the client did.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { geminiServePipeline } from '../../../src/data-plane/chat/gemini/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import { directFetcher, type ModelCandidate, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

/** The live candidates the resolver hands back. They never enter the record: a candidate
 *  carries the provider's instance, its fetcher and its models cache, and freezing those is
 *  what putting one in the record would do. What travels is the selector. */
let live: readonly ModelCandidate[] = [];

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] });
};

const resolveAttempt = (selector: { readonly upstreamId: string }): ModelCandidate => {
  const found = live.find(candidate => candidate.provider.upstreamId === selector.upstreamId);
  if (found === undefined) throw new Error(`no live candidate for ${selector.upstreamId}`);
  return found;
};

type CallChatCompletions = (
  model: unknown,
  body: unknown,
  signal: AbortSignal | undefined,
  opts: UpstreamCallOptions,
) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;

const candidate = (upstream: string, callChatCompletions: CallChatCompletions): ModelCandidate => {
  const endpoints = { chatCompletions: {} };
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callChatCompletions: callChatCompletions as never }),
    },
    model: stubInternalModel({ id: 'gemini-2.5-pro', endpoints, providerModels: { [upstream]: stubProviderModel({ id: 'gemini-2.5-pro', endpoints }) } }, upstream),
    fetcher: directFetcher,
  };
};

const chunk = (delta: Record<string, unknown>, finishReason?: string): ProtocolFrame<ChatCompletionsStreamEvent> =>
  eventFrame({
    id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'gemini-2.5-pro',
    choices: [{ index: 0, delta, ...(finishReason === undefined ? {} : { finish_reason: finishReason }) }],
  } as ChatCompletionsStreamEvent);

const usageChunk: ProtocolFrame<ChatCompletionsStreamEvent> = eventFrame({
  id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'gemini-2.5-pro',
  choices: [],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
} as ChatCompletionsStreamEvent);

/** One whole turn on the wire below: two content deltas, the figures the upstream metered,
 *  and the sentinel that ends it. */
const turn = (): AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    yield chunk({ content: 'he' });
    yield chunk({ content: 'llo' }, 'stop');
    yield usageChunk;
    yield doneFrame();
  })(),
});

const streamed = (
  events: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  headers?: Headers,
): ProviderStreamResult<ChatCompletionsStreamEvent> => ({
  ok: true, events, modelKey: 'gemini-2.5-pro-key', ...(headers === undefined ? {} : { headers }),
});

const payload = { contents: [{ role: 'user' as const, parts: [{ text: 'hello' }] }] };

/** What affinity materialized for the candidate about to be dialled. It differs from the
 *  turn the client sent, which is the point: carried state is rewritten per candidate. */
let affinityPayload: GeminiPayload = payload;

/** Which candidates the run said a follow-up turn must come back to. */
const selected: ModelCandidate[] = [];

// Settlement is part of every serve pipeline, and it writes. A test that drives a whole
// pipeline therefore needs somewhere for the row to go.
const recorded: { usage: unknown[]; performance: unknown[] } = { usage: [], performance: [] };

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  recorded.usage = [];
  recorded.performance = [];
  selected.length = 0;
  affinityPayload = payload;
  initRepo({
    usage: { record: async (row: unknown) => { recorded.usage.push(row); } },
    performance: {
      recordNeutral: async (dims: unknown) => { recorded.performance.push(dims); },
      recordZeroOutputError: async (dims: unknown) => { recorded.performance.push(dims); },
    },
  } as never);
});

const serve = async (facts: Record<string, unknown>) => await run(
  geminiServePipeline(payload),
  move(facts) as never,
  {
    gateway: mockChatGatewayCtx({ wantsStream: facts['ingress.chat.gemini.wantsStream'] === true }),
    background: () => {},
    rememberCandidates: () => {},
    rememberChatSelection: () => {},
    chatPayloadFor: () => affinityPayload,
    selectAffinity: (candidate: ModelCandidate) => { selected.push(candidate); },
    resolveAttempt,
  } as never,
);

const entryFacts = (overrides: Record<string, unknown> = {}) => ({
  'ingress.chat.gemini.wantsStream': true,
  'ingress.chat.sourceProtocol': 'gemini',
  'ingress.http.headers': [],
  'request.chat.gemini': payload,
  'serve.model': 'gemini-2.5-pro',
  ...overrides,
});

const collect = async (rendered: unknown): Promise<readonly SseFrame[]> => {
  const frames: SseFrame[] = [];
  for await (const frame of rendered as AsyncIterable<SseFrame>) frames.push(frame);
  return frames;
};

describe('the gemini pipeline', () => {
  // The whole entry contract, and it does not mention `request.chat.gemini` — the stage that
  // reads the turn is the ending, a stage whose only trait is `return` declares no request
  // side at all, and so assembly cannot see what it reads. A caller who omits the payload
  // gets a runtime failure at the deepest stage rather than the assembly error the entry
  // contract exists to give it.
  it('assembles, and asks its caller only for what the descending stages need', () => {
    expect([...geminiServePipeline(payload).entryNeeds].sort()).toEqual([
      'ingress.chat.gemini.wantsStream',
      'serve.model',
    ]);
  });

  it('translates the turn out, dials the Chat Completions wire, and streams Gemini frames back', async () => {
    let sent: Record<string, unknown> | undefined;
    resolves([candidate('up_a', async (_model, body) => {
      sent = body as Record<string, unknown>;
      return streamed(turn());
    })]);

    const { facts, drain } = await serve(entryFacts());

    // The answer comes back before the drain runs, which is what lets a streaming family
    // hand its stream on: the frames are still there to read.
    expect((await collect(facts['response.chat.gemini.rendered'])).map(frame => JSON.parse(frame.data) as unknown)).toEqual([
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'he' }] } }] },
      {
        candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'llo' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
      },
    ]);
    // What went out is the translated turn, addressed to the candidate's own id — which the
    // ending then strips, because the provider re-stamps what it resolved upstream.
    expect(sent).toMatchObject({ stream: true, messages: [{ role: 'user', content: 'hello' }] });
    expect(sent).not.toHaveProperty('model');
    await drain();
  });

  // Gemini carries its state in `thoughtSignature` parts, which only mean anything to the
  // upstream that issued them — so the turn that is translated is the one affinity rewrote
  // for this candidate, and the candidate that answered is marked for the next turn.
  it('translates what affinity materialized, and marks the candidate that answered', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = { contents: [{ role: 'user', parts: [{ text: 'rewritten' }] }] };
    const dialled = candidate('up_a', async (_model, body) => {
      sent = body as Record<string, unknown>;
      return streamed(turn());
    });
    resolves([dialled]);

    const { facts, drain } = await serve(entryFacts());
    await collect(facts['response.chat.gemini.rendered']);

    expect(sent).toMatchObject({ messages: [{ role: 'user', content: 'rewritten' }] });
    expect(selected).toEqual([dialled]);
    await drain();
  });

  it('folds the frames into one Gemini result for a client that did not ask to stream', async () => {
    resolves([candidate('up_a', async () => streamed(turn()))]);

    const { facts, drain } = await serve(entryFacts({ 'ingress.chat.gemini.wantsStream': false }));

    expect(facts['response.chat.gemini.rendered']).toEqual({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
    });
    expect(facts['response.http.status']).toBe(200);
    await drain();
  });

  it('fails a refusal over to the next candidate, and answers in the last upstream-s own words', async () => {
    const tried: string[] = [];
    resolves([
      candidate('up_a', async () => {
        tried.push('up_a');
        return { ok: false, response: Response.json({ error: { message: 'slow down' } }, { status: 429 }), modelKey: 'k' };
      }),
      candidate('up_b', async () => {
        tried.push('up_b');
        return { ok: false, response: Response.json({ error: { message: 'no' } }, { status: 400 }), modelKey: 'k' };
      }),
    ]);

    const { facts, drain } = await serve(entryFacts());

    expect(tried).toEqual(['up_a', 'up_b']);
    // Every candidate failed, so the last failure is the base: the client sees the status an
    // upstream actually returned and the words that upstream used, rather than a synthesized
    // envelope quoting its serialized body back as a message.
    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.chat.gemini.rendered']).toEqual({ error: { message: 'no' } });
    // An upstream that was called and reported nothing, which is a different statement from
    // reporting zero.
    expect(facts['response.usage.billable']).toEqual([
      { identity: { model: 'gemini-2.5-pro', upstream: 'up_b', modelKey: 'k', pricing: null }, quantities: {} },
    ]);
    await drain();
  });

  it('turns a dial that threw into a failure value rather than a thrown run', async () => {
    resolves([candidate('up_a', () => Promise.reject(new Error('socket hang up')))]);

    const { facts, drain } = await serve(entryFacts());

    expect(facts['response.http.status']).toBe(502);
    expect(facts['response.chat.gemini.rendered']).toEqual({ error: { message: 'socket hang up', type: 'api_error' } });
    // A dial that never completed reached no upstream, so nothing was billed and there are no
    // headers to carry.
    expect(facts['response.usage.billable']).toEqual([]);
    expect(facts['response.http.headers']).toEqual([]);
    await drain();
  });

  it('forwards the upstream headers a client may see and drops the ones it may not', async () => {
    resolves([candidate('up_a', async () => streamed(turn(), new Headers({
      'content-type': 'text/event-stream',
      'transfer-encoding': 'chunked',
      'x-request-id': 'req_1',
    })))]);

    const { facts, drain } = await serve(entryFacts());

    expect(facts['response.http.headers']).toEqual([['x-request-id', 'req_1']]);
    await collect(facts['response.chat.gemini.rendered']);
    await drain();
  });

  // The wire below always streams, whatever the client asked for, so this family's numbers
  // always arrive with the last chunk — which is after the run has answered. Settling in the
  // stage as well would write the row twice, so the pipeline hands the numbers up as a promise
  // and the epilogue is what writes them.
  it('defers settlement to the promise it hands up, metered on the dialect the upstream spoke', async () => {
    resolves([candidate('up_a', async () => streamed(turn()))]);

    const { facts, drain } = await serve(entryFacts());
    await collect(facts['response.chat.gemini.rendered']);
    await drain();

    expect(recorded.usage).toHaveLength(0);
    const usage = facts['response.chat.gemini.streamedUsage'];
    expect(usage).not.toBeNull();
    expect(await usage!).toEqual([
      {
        identity: { model: 'gemini-2.5-pro', upstream: 'up_a', modelKey: 'gemini-2.5-pro-key', pricing: null },
        quantities: { input_tokens: '5', output_tokens: '7' },
      },
    ]);
  });
});
