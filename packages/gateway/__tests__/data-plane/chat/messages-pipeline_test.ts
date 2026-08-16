// The Messages chain, run. Assembly is checked where every family's is; what is written
// down here is what only running it can say — that the edge writes Anthropic's own named
// SSE events when the client asked to stream and reassembles them into one message when it
// did not, that it hands the turn's own state back for the client to carry, that a refusal
// keeps the upstream's own status and words, that a dial nobody answered is a value the fork
// can move past, that the beta flags travel on their typed path rather than as a header, and
// that what the two usage-bearing events add up to is billed in the metrics settlement reads.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messagesServePipeline } from '../../../src/data-plane/chat/messages/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import { MESSAGES_MISSING_TERMINAL_MESSAGE, type MessagesPayload, type MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { directFetcher, type MessagesUpstreamCallOptions, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

type CallMessages = (
  model: unknown,
  body: unknown,
  signal: AbortSignal | undefined,
  opts: MessagesUpstreamCallOptions,
) => Promise<ProviderStreamResult<MessagesStreamEvent>>;

const candidate = (callMessages: CallMessages, upstreamId = 'up_a'): ModelCandidate => {
  const endpoints = { messages: {} };
  return {
    provider: {
      upstreamId, kind: 'claude-code', name: upstreamId,
      // Wide enough that a header reaching the provider proves the stage let it through,
      // rather than proving only that the allowlist did.
      inboundHeaderAllowlist: [/^(anthropic-beta|x-trace)$/],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callMessages: callMessages as never }),
    },
    model: stubInternalModel(
      { id: 'claude-model', endpoints, providerModels: { [upstreamId]: stubProviderModel({ id: 'claude-model', endpoints }) } },
      upstreamId,
    ),
    fetcher: directFetcher,
  } as unknown as ModelCandidate;
};

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] } as never);
};

// One well-formed turn: Anthropic states input accounting on `message_start` and output
// accounting on `message_delta`, so a stream that says what it cost says it in two places.
const messageStart = {
  type: 'message_start',
  message: {
    id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-model',
    stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 2 },
  },
};
const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const blockStop = { type: 'content_block_stop', index: 0 };
const messageDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } };
const messageStop = { type: 'message_stop' };

const turn = (...text: readonly string[]): readonly unknown[] =>
  [messageStart, blockStart, ...text.map(textDelta), blockStop, messageDelta, messageStop];

/** The same turn with its terminal event cut off, which is what an upstream that died
 *  mid-answer leaves behind. */
const truncatedTurn = (...text: readonly string[]): readonly unknown[] =>
  turn(...text).filter(event => event !== messageStop);

const stream = (events: readonly unknown[]): ProviderStreamResult<MessagesStreamEvent> => ({
  ok: true,
  modelKey: 'claude-model-key',
  headers: new Headers({ 'x-request-id': 'req-1', 'content-length': '99' }),
  events: (async function* () {
    for (const event of events) yield { type: 'event' as const, event: event as MessagesStreamEvent };
    yield { type: 'done' as const };
  })(),
});

const payload = { model: 'claude-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] } as unknown as MessagesPayload;

/** What affinity materialized for the candidate about to be dialled. It differs from the
 *  payload the client sent, which is the point: carried state is rewritten per candidate. */
let affinityPayload: MessagesPayload = payload;

/** How many times the chain asked the resolver for that payload. One stage owns the reading;
 *  anything below it reads the record. */
let asked = 0;

const serve = async (wantsStream: boolean, headers: readonly (readonly [string, string])[] = []) =>
  await serveWith(mockChatGatewayCtx({ wantsStream }), wantsStream, headers);

const serveWith = async (
  gateway: ReturnType<typeof mockChatGatewayCtx>,
  wantsStream: boolean,
  headers: readonly (readonly [string, string])[] = [],
) => await run(
  messagesServePipeline(payload),
  move({
    'ingress.http.headers': headers,
    'ingress.chat.sourceProtocol': 'messages',
    'ingress.chat.messages.wantsStream': wantsStream,
    'request.chat.messages': payload,
    'serve.model': 'claude-model',
  }) as never,
  {
    gateway,
    background: () => {},
    rememberCandidates: () => {},
    rememberChatSelection: () => {},
    chatPayloadFor: () => { asked += 1; return affinityPayload; },
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

const collect = async (rendered: unknown): Promise<readonly SseFrame[]> => {
  const frames: SseFrame[] = [];
  for await (const frame of rendered as AsyncIterable<SseFrame>) frames.push(frame);
  return frames;
};

// The carrier the edge writes back is a redacted_thinking block holding this turn's own
// state. Messages has real block boundaries, so it takes content block 0 of its own: its
// start and stop are the two extra frames, and the turn's own blocks answer behind it.

/** The turn's own frames, with the carrier block's dropped. */
const withoutCarrier = (frames: readonly SseFrame[]): readonly SseFrame[] => {
  const carrierBlocks = new Set<number>();
  return frames.filter(frame => {
    const event = JSON.parse(frame.data) as {
      readonly type: string;
      readonly index?: number;
      readonly content_block?: { readonly type: string };
    };
    if (event.index === undefined) return true;
    if (event.type === 'content_block_start' && event.content_block?.type === 'redacted_thinking') {
      carrierBlocks.add(event.index);
    }
    return !carrierBlocks.has(event.index);
  });
};

/** The same events, at the block index the carrier leaves them at. */
const behindCarrier = (events: readonly unknown[]): readonly unknown[] =>
  events.map(event => {
    const block = event as { readonly index?: number };
    return block.index === undefined ? event : { ...block, index: block.index + 1 };
  });

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  affinityPayload = payload;
  asked = 0;
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('the messages chain', () => {
  // Affinity rewrites client-carried state — a thinking signature only its issuer can read —
  // for the upstream that will see it, so the body that goes out is the one it materialized
  // rather than the one the client sent. It enters the record below the fork because
  // everything between there and the dial rewrites the request as a fact, and one stage owns
  // that reading: an ending that asked the resolver again would send a payload no stage in
  // the chain had touched.
  it('puts the payload this attempt is owed into the record, and sends that', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = { ...payload, messages: [{ role: 'user', content: 'rewritten' }] } as MessagesPayload;
    resolves([candidate(async (_model, body) => {
      sent = body as Record<string, unknown>;
      return stream(turn('hi'));
    })]);

    const { facts } = await serve(false);

    // The exit contract names what the run answers with, and the request the chain sent is
    // not that — but the record carries every key in flight, so what was sent is still there
    // to read.
    expect((facts as Record<string, unknown>)['request.chat.messages']).toBe(affinityPayload);
    expect(asked).toBe(1);
    // The id the client addressed does not travel: the provider re-stamps what it resolved.
    expect(sent).toMatchObject({ messages: [{ role: 'user', content: 'rewritten' }] });
    expect(sent).not.toHaveProperty('model');
  });

  // Anthropic's clients dispatch on the SSE event name, not on the payload alone, so the
  // name each frame carries is part of the answer.
  it('writes the frames out under their own event names when the client asked to stream', async () => {
    resolves([candidate(async () => stream(turn('he', 'llo')))]);

    const { facts } = await serve(true);
    const frames = withoutCarrier(await collect(facts['response.chat.messages.rendered']));

    expect(facts['response.http.status']).toBe(200);
    expect(frames.map(frame => frame.event)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
    expect(frames.map(frame => frame.data)).toEqual(behindCarrier(turn('he', 'llo')).map(event => JSON.stringify(event)));
  });

  // The other half of affinity: the resolver reads client-carried state on the way down, and
  // this is what the client is given to carry back. A turn that handed back nothing would
  // leave the follow-up quoting it with no way to name the upstream that issued it.
  it('hands the turn-s own state back on a block of its own', async () => {
    resolves([candidate(async () => stream(turn('hi')))]);
    const gateway = mockChatGatewayCtx({ wantsStream: true });

    const { facts } = await serveWith(gateway, true);
    const frames = await collect(facts['response.chat.messages.rendered']);
    const carrier = frames
      .map(frame => JSON.parse(frame.data) as { readonly type: string; readonly content_block?: { readonly type: string; readonly data: string } })
      .filter(event => event.type === 'content_block_start' && event.content_block?.type === 'redacted_thinking');

    expect(carrier).toHaveLength(1);
    // It names the upstream that answered, sealed under this run's own secret — which is what
    // lets the next turn be pinned to it.
    expect(await gateway.affinity.codec.unwrap(carrier[0]!.content_block!.data, 'messages.redacted_thinking.data')).toMatchObject({
      kind: 'owned',
      affinity: { upstreamId: 'up_a', modelId: 'claude-model' },
    });
  });

  // The upstream speaks SSE whatever the client asked for, so a client that did not ask to
  // stream is answered from the same frames — folded here rather than read a second time.
  it('reassembles the frames into one message when the client did not', async () => {
    resolves([candidate(async () => stream(turn('he', 'llo')))]);

    const { facts } = await serve(false);
    const rendered = facts['response.chat.messages.rendered'] as {
      readonly type: string;
      readonly content: readonly { readonly type: string; readonly text?: string }[];
      readonly stop_reason: string;
      readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
    };

    expect(facts['response.http.status']).toBe(200);
    expect(rendered.type).toBe('message');
    expect(rendered.content.filter(block => block.type !== 'redacted_thinking').map(block => block.text)).toEqual(['hello']);
    expect(rendered.stop_reason).toBe('end_turn');
    expect(rendered.usage).toMatchObject({ input_tokens: 5, output_tokens: 7 });
  });

  // Content-length would misdescribe a body this gateway serialized itself; a vendor trace
  // is what a client and an operator both need to correlate a turn.
  it('forwards the upstream headers a client may see and drops the ones it may not', async () => {
    resolves([candidate(async () => stream(turn('hi')))]);

    const { facts } = await serve(true);

    expect(Object.fromEntries(facts['response.http.headers'])).toMatchObject({ 'x-request-id': 'req-1' });
    expect(Object.fromEntries(facts['response.http.headers'])).not.toHaveProperty('content-length');
  });

  it('answers an upstream refusal with its own status and words', async () => {
    resolves([candidate(async () => ({
      ok: false,
      modelKey: 'claude-model-key',
      response: new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
        status: 429, headers: { 'content-type': 'application/json' },
      }),
    }))]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(429);
    expect(facts['response.chat.messages.rendered']).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
  });

  // A refused connection is an outcome the fork has to be able to see, not a fault that ends
  // the run — so the second candidate is tried and its answer is the one served.
  it('fails a dial that never connected over to the next candidate', async () => {
    const tried: string[] = [];
    resolves([
      candidate(async () => { tried.push('dead'); throw new Error('ECONNREFUSED'); }, 'up_dead'),
      candidate(async () => { tried.push('alive'); return stream(turn('hi')); }, 'up_alive'),
    ]);

    const { facts } = await serve(false);

    expect(tried).toEqual(['dead', 'alive']);
    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.chat.messages.rendered']).toMatchObject({ type: 'message' });
  });

  // Anthropic beta flags have a typed path of their own precisely so no provider's header
  // allowlist can admit them and no other source protocol can leak them in — so the field is
  // read off the client's request and does not travel beside itself.
  it('hands the beta flags over on their own path and not as a header', async () => {
    let seen: MessagesUpstreamCallOptions | undefined;
    resolves([candidate(async (_model, _body, _signal, opts) => {
      seen = opts;
      return stream(turn('hi'));
    })]);

    await serve(false, [
      ['anthropic-beta', 'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14'],
      ['x-trace', 'abc'],
    ]);

    expect(seen?.anthropicBeta).toEqual(['oauth-2025-04-20', 'fine-grained-tool-streaming-2025-05-14']);
    expect(seen?.headers.get('anthropic-beta')).toBeNull();
    expect(seen?.headers.get('x-trace')).toBe('abc');
  });

  // The reading is per billing metric, which is not the shape Anthropic reports in: input
  // accounting arrives on `message_start` and output accounting on `message_delta`, and what
  // settlement writes is what the two add up to after the client's own stream drove them out.
  it('bills what the upstream metered across both of its usage events', async () => {
    resolves([candidate(async () => stream(turn('hi')))]);

    const { facts } = await serve(true);

    // Before the drain: called, and reported nothing — the numbers arrive with the last
    // frame, which is after this run has answered.
    expect(facts['response.usage.billable']).toEqual([
      { identity: { model: 'claude-model', upstream: 'up_a', modelKey: 'claude-model-key', pricing: null }, quantities: {} },
    ]);

    await collect(facts['response.chat.messages.rendered']);
    const outcome = await facts['response.chat.messages.streamedUsage']!;
    const billable = outcome.billable;

    expect(billable[0]).toMatchObject({
      identity: { model: 'claude-model', upstream: 'up_a', modelKey: 'claude-model-key', pricing: null },
      quantities: { input_tokens: '5', input_cache_read_tokens: '2', output_tokens: '7' },
    });
    // A rate can depend on the tier and on how much input there was; both are selector
    // coordinates, so they travel as pricing facts rather than as quantities.
    expect(billable[0]!.pricingFacts).toMatchObject({ inputTokens: 7 });
  });

  // Time to first token is measured where the token is — `message_start` and
  // `content_block_start` are the envelope around the answer, not the answer, and a run that
  // never stamps it is recorded as having produced nothing to time.
  it('stamps the first frame that carried a generated token', async () => {
    resolves([candidate(async () => stream(turn('hi')))]);
    const gateway = mockChatGatewayCtx({ wantsStream: true });

    const { facts } = await serveWith(gateway, true);
    expect(gateway.attempt.firstOutputTokenAt).toBeNull();
    await collect(facts['response.chat.messages.rendered']);

    expect(gateway.attempt.firstOutputTokenAt).toBeTypeOf('number');
  });

  // A turn is over at `message_stop`, so what an upstream writes after it is not part of the
  // answer and the client is not shown it. Reading stops there, which also closes the
  // upstream rather than leaving the client's stream open behind a connection nobody reads.
  it('stops reading at the terminal event', async () => {
    resolves([candidate(async () => stream([...turn('hi'), textDelta(' and more')]))]);

    const { facts } = await serve(true);
    const frames = withoutCarrier(await collect(facts['response.chat.messages.rendered']));

    expect(frames.map(frame => frame.event)).toEqual([
      'message_start', 'content_block_start', 'content_block_delta',
      'content_block_stop', 'message_delta', 'message_stop',
    ]);
  });

  // A stream that ran out before `message_stop` is a turn nobody can answer from: the message
  // was never stopped and never failed, so serving what did arrive would report a truncated
  // answer as a whole one.
  it('fails a stream that ended without its terminal event', async () => {
    resolves([candidate(async () => stream(truncatedTurn('hi')))]);

    const { facts } = await serve(true);

    await expect(collect(facts['response.chat.messages.rendered'])).rejects.toThrow(MESSAGES_MISSING_TERMINAL_MESSAGE);
  });
});
