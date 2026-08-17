// The Responses chain, run. Assembly is checked where every family's is; what is written
// down here is what only running it can say — that the edge terminates the client's stream
// on `[DONE]` however the upstream's ended, that it folds a stream into one response object
// when the client did not ask to stream, that it hands the turn's own state back for the
// client to carry, that the stored-items membrane's other half runs there too so the client
// is answered under an envelope this gateway minted, that a turn the upstream answered with
// one envelope instead of a stream is served as that envelope, that a turn asking for a
// compaction is answered with one wherever the shim is this candidate's to run and travels on
// untouched where it is not, that a refusal keeps the upstream's own status and words, and
// that a dial nobody answered is a value the fork can move past.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SUMMARY_PREFIX } from '../../../src/data-plane/chat/responses/compact-shim.ts';
import { responsesServePipeline } from '../../../src/data-plane/chat/responses/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../src/shared/base64url-json.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { ModelEndpoints, SseFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { RESPONSES_MISSING_TERMINAL_MESSAGE, type CanonicalResponsesPayload, type ResponsesCompactionResult, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { directFetcher, type FlagId, type ModelCandidate, type ProviderResponsesResult, type ProviderStreamResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

const candidate = (
  calls: {
    callResponses?: (model: unknown, body: unknown, action: unknown) => Promise<ProviderResponsesResult>;
    callMessages?: (model: unknown, body: unknown) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  },
  overrides: { upstreamId?: string; endpoints?: ModelEndpoints; enabledFlags?: ReadonlySet<FlagId> } = {},
): ModelCandidate => {
  const upstreamId = overrides.upstreamId ?? 'up_a';
  const endpoints = overrides.endpoints ?? { responses: {} };
  const enabledFlags = overrides.enabledFlags ?? new Set<FlagId>();
  return {
    provider: {
      upstreamId, kind: 'custom', name: upstreamId, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider(calls as never),
    },
    model: stubInternalModel(
      {
        id: 'responses-model',
        endpoints,
        limits: { max_output_tokens: 4096 },
        providerModels: { [upstreamId]: stubProviderModel({ id: 'responses-model', endpoints, enabledFlags }) },
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

const delta = (text: string): ResponsesStreamEvent => ({
  type: 'response.output_text.delta',
  sequence_number: 1,
  item_id: 'msg_1',
  output_index: 0,
  content_index: 0,
  delta: text,
});

const result = (text: string, usage?: ResponsesResult['usage']): ResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: 'responses-model',
  status: 'completed',
  output: [{
    type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }],
  error: null,
  incomplete_details: null,
  ...(usage === undefined ? {} : { usage }),
});

const completed = (text: string, usage?: ResponsesResult['usage']): ResponsesStreamEvent => ({
  type: 'response.completed',
  sequence_number: 2,
  response: result(text, usage),
});

// The upstream's own stream, as the provider hands it up: typed frames, and the `done` frame
// its SSE transport ended on.
const stream = (...events: readonly ResponsesStreamEvent[]): ProviderResponsesResult => ({
  action: 'generate',
  ok: true,
  modelKey: 'responses-model-key',
  headers: new Headers({ 'x-request-id': 'req-1', 'content-length': '99' }),
  events: (async function* () {
    for (const event of events) yield { type: 'event' as const, event };
    yield { type: 'done' as const };
  })(),
});

/** One assistant message over the Messages wire, which is the only way a Messages-only
 *  candidate can be reached: the turn crosses into that protocol and comes back translated. */
const messagesTurn = (text: string, seen: { body?: Record<string, unknown> } = {}) =>
  async (_model: unknown, body: unknown): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
    seen.body = body as Record<string, unknown>;
    const events: unknown[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'responses-model',
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ];
    return {
      ok: true, modelKey: 'responses-model-key', headers: new Headers(),
      events: (async function* () {
        for (const event of events) yield { type: 'event' as const, event: event as MessagesStreamEvent };
        yield { type: 'done' as const };
      })(),
    };
  };

const payload = {
  model: 'responses-model',
  input: [{ type: 'message', role: 'user', content: 'hi' }],
} as unknown as CanonicalResponsesPayload;

/** What affinity materialized for the candidate about to be dialled. It differs from the
 *  payload the client sent, which is the point: carried state is rewritten per candidate. */
let affinityPayload: CanonicalResponsesPayload = payload;

/** How many times the chain asked the resolver for that payload. One stage owns the reading;
 *  anything below it reads the record. */
let asked = 0;

const serve = async (wantsStream: boolean, request: CanonicalResponsesPayload = payload) =>
  await serveWith(mockChatGatewayCtx({ wantsStream }), wantsStream, request);

const serveWith = async (
  gateway: ReturnType<typeof mockChatGatewayCtx>,
  wantsStream: boolean,
  request: CanonicalResponsesPayload = payload,
) => await run(
  responsesServePipeline(request),
  move({
    'ingress.http.headers': [] as readonly (readonly [string, string])[],
    'ingress.chat.sourceProtocol': 'responses',
    'ingress.chat.responses.wantsStream': wantsStream,
    'request.chat.responses': request,
    'serve.model': 'responses-model',
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

const drain = async (rendered: unknown): Promise<SseFrame[]> => {
  const frames: SseFrame[] = [];
  for await (const frame of rendered as AsyncIterable<SseFrame>) frames.push(frame);
  return frames;
};

// The carrier the edge writes back is a reasoning item holding this turn's own state. The
// message this turn answers with cannot hold it, so the carrier gets an output slot of its
// own at the head of the answer: two frames, and a slot in every snapshot that follows them.
const isCarrierItem = (item: ResponsesOutputItem): boolean => item.type === 'reasoning';

/** The turn's own answer, with the carrier's item taken back out. */
const withoutCarrierItem = (response: ResponsesResult): ResponsesResult =>
  ({ ...response, output: response.output.filter(item => !isCarrierItem(item)) });

/** The turn's own frames. The two sequence numbers the carrier's frames spent stay spent —
 *  they are numbers the client saw. */
const withoutCarrier = (frames: readonly SseFrame[]): readonly SseFrame[] =>
  frames.flatMap(frame => {
    if (frame.data === '[DONE]') return [frame];
    const event = JSON.parse(frame.data) as ResponsesStreamEvent;
    if (
      (event.type === 'response.output_item.added' || event.type === 'response.output_item.done')
      && isCarrierItem(event.item)
    ) return [];
    if (!('response' in event)) return [frame];
    return [{ ...frame, data: JSON.stringify({ ...event, response: withoutCarrierItem(event.response) }) }];
  });

/** A turn asking for a compaction, which on this protocol is an ordinary turn whose input
 *  ends in the control item that requests one. */
const asksForCompaction = {
  ...payload,
  input: [
    { type: 'message', role: 'user', content: 'a long conversation' },
    { type: 'compaction_trigger' },
  ],
} as unknown as CanonicalResponsesPayload;

/** The compaction item out of what the client was answered with. */
const compactionItem = (answered: Record<string, unknown>): { readonly encrypted_content: string } => {
  const item = (answered.output as { type: string }[]).find(candidateItem => candidateItem.type === 'compaction');
  if (item === undefined) throw new Error('expected the answer to carry a compaction item');
  return item as unknown as { readonly encrypted_content: string };
};

/** The summary a simulated compaction packed into the item the client is handed. The turn's
 *  own state is sealed around it on the way out — that is what pins the next turn to the
 *  upstream that issued this one — so the carrier is opened before the blob is read. */
const summaryIn = async (
  gateway: ReturnType<typeof mockChatGatewayCtx>,
  encryptedContent: string,
): Promise<string> => {
  const carrier = await gateway.affinity.codec.unwrap(encryptedContent, 'responses.compaction.encrypted_content');
  if (carrier.kind !== 'owned' || carrier.value === undefined) throw new Error('expected the turn-s own carrier around the blob');
  const items = decodeBase64UrlJson(carrier.value) as { content: { text: string }[] }[] | null;
  if (items === null) throw new Error('expected a shim-encoded compaction blob');
  return items[0]!.content[0]!.text;
};

beforeEach(() => {
  affinityPayload = payload;
  asked = 0;
  vi.mocked(enumerateModelCandidates).mockReset();
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('the responses chain', () => {
  // Affinity rewrites client-carried state for the upstream that will see it, so the body
  // that goes out is the one it materialized rather than the one the client sent — and this
  // chain dials the generate action, whatever else the protocol can ask an upstream for. The
  // payload enters the record below the fork because everything between there and the dial
  // rewrites the request as a fact, and one stage owns that reading: an ending that asked the
  // resolver again would send a payload no stage in the chain had touched.
  it('puts the payload this attempt is owed into the record, and sends that', async () => {
    let sent: Record<string, unknown> | undefined;
    let action: unknown;
    affinityPayload = {
      ...payload,
      input: [{ type: 'message', role: 'user', content: 'rewritten' }],
    } as CanonicalResponsesPayload;
    resolves([candidate({
      callResponses: async (_model, body, asks) => {
        sent = body as Record<string, unknown>;
        action = asks;
        return stream(completed('hi'));
      },
    })]);

    const { facts } = await serve(false);

    // The exit contract names what the run answers with, and the request the chain sent is
    // not that — but the record carries every key in flight, so what was sent is still there
    // to read.
    expect((facts as Record<string, unknown>)['request.chat.responses']).toBe(affinityPayload);
    expect(asked).toBe(1);
    expect(sent).toMatchObject({ input: [{ type: 'message', role: 'user', content: 'rewritten' }] });
    expect(sent).not.toHaveProperty('model');
    expect(action).toBe('generate');
  });

  // Copilot's compaction translation and Azure-native compaction both emit assistant messages
  // whose content blocks say `input_text`, and both then refuse those same items echoed back
  // as input. The wire puts the canonical type back on whatever reaches it, however the
  // history got there — a client echo, or the snapshot the membrane replayed.
  it('sends an assistant item back in the content type this wire accepts', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = {
      ...payload,
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'summary so far' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and then?' }] },
      ],
    } as unknown as CanonicalResponsesPayload;
    resolves([candidate({
      callResponses: async (_model, body) => {
        sent = body as Record<string, unknown>;
        return stream(completed('hi'));
      },
    })]);

    await serve(false);

    // Only the assistant's: `input_text` IS the correct type on a user message.
    expect(sent).toMatchObject({
      input: [
        { role: 'assistant', content: [{ type: 'output_text', text: 'summary so far' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'and then?' }] },
      ],
    });
  });

  // Every event goes out under its own SSE name, and the client's stream ends on the literal
  // `[DONE]` the transport reads as the turn being over.
  it('writes the frames out when the client asked to stream', async () => {
    resolves([candidate({ callResponses: async () => stream(delta('he'), delta('llo'), completed('hello')) })]);

    const { facts } = await serve(true);
    const frames = withoutCarrier(await drain(facts['response.chat.responses.rendered']));

    expect(facts['response.http.status']).toBe(200);
    expect(frames.map(frame => frame.event)).toEqual([
      'response.output_text.delta',
      'response.output_text.delta',
      'response.completed',
      undefined,
    ]);
    expect(frames.slice(0, 2).map(frame => frame.data)).toEqual([
      JSON.stringify(delta('he')),
      JSON.stringify(delta('llo')),
    ]);
    expect(frames[3]!.data).toBe('[DONE]');

    // The terminal event is the upstream's, restated: the membrane at the edge stamps the
    // envelope id this gateway minted for the turn and completes the resource to what the
    // schema requires of it, so the deltas ride through untouched and this one does not.
    const terminal = JSON.parse(frames[2]!.data) as { sequence_number: number; response: ResponsesResult };
    // The carrier's own two frames went out ahead of it under two sequence numbers of their
    // own, so the terminal event is numbered where they left it.
    expect(terminal.sequence_number).toBe(4);
    expect(terminal.response).toMatchObject({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: 'hello' }] }],
    });
    expect(terminal.response.id).not.toBe('resp_1');
  });

  // The other half of affinity: the resolver reads client-carried state on the way down, and
  // this is what the client is given to carry back. A turn that handed back nothing would
  // leave the follow-up quoting it with no way to name the upstream that issued it.
  it('hands the turn-s own state back on an item of its own', async () => {
    resolves([candidate({ callResponses: async () => stream(delta('hi'), completed('hi')) })]);
    const gateway = mockChatGatewayCtx({ wantsStream: true });

    const { facts } = await serveWith(gateway, true);
    const frames = await drain(facts['response.chat.responses.rendered']);
    const answered = frames.find(frame => frame.event === 'response.completed');
    const carrier = (JSON.parse(answered!.data) as { readonly response: ResponsesResult }).response.output
      .filter(item => item.type === 'reasoning');

    expect(carrier).toHaveLength(1);
    // It names the upstream that answered, sealed under this run's own secret — which is what
    // lets the next turn be pinned to it. The item is ours rather than the upstream's, and it
    // says so, so a turn quoting it back is not read as reasoning the upstream produced.
    expect(await gateway.affinity.codec.unwrap(carrier[0]!.encrypted_content!, 'responses.reasoning.encrypted_content')).toMatchObject({
      kind: 'owned',
      syntheticItem: true,
      affinity: { upstreamId: 'up_a', modelId: 'responses-model' },
    });
  });

  // A stream's numbers arrive with its last chunk, so what the run hands up is a promise and
  // the reading is taken off the frames the client itself drove.
  it('bills what the terminal event reported, once the frames have run out', async () => {
    resolves([candidate({
      callResponses: async () => stream(
        delta('hi'),
        completed('hi', { input_tokens: 11, output_tokens: 7, total_tokens: 18 }),
      ),
    })]);

    const { facts } = await serve(true);
    await drain(facts['response.chat.responses.rendered']);
    const outcome = await facts['response.chat.responses.streamedUsage']!;
    const billable = outcome.billable;

    expect(billable).toEqual([expect.objectContaining({
      quantities: { input_tokens: '11', output_tokens: '7' },
    })]);
    // A rate can depend on the tier and on how much input there was; both are selector
    // coordinates, so they travel as pricing facts rather than as quantities.
    expect(billable[0]!.pricingFacts).toMatchObject({ inputTokens: 11 });
  });

  // Time to first token is measured where the token is — a lifecycle envelope is not one, and
  // a run that never stamps it is recorded as having produced nothing to time.
  it('stamps the first frame that carried a generated token', async () => {
    resolves([candidate({ callResponses: async () => stream(delta('hi'), completed('hi')) })]);
    const gateway = mockChatGatewayCtx({ wantsStream: true });

    const { facts } = await serveWith(gateway, true);
    expect(gateway.attempt.firstOutputTokenAt).toBeNull();
    await drain(facts['response.chat.responses.rendered']);

    expect(gateway.attempt.firstOutputTokenAt).toBeTypeOf('number');
  });

  // The turn is over at its terminal event, so what an upstream writes after it is not part
  // of the answer and the client is not shown it. Reading stops there, which also closes the
  // upstream rather than leaving the client's stream open behind a connection nobody reads.
  it('stops reading at the terminal event', async () => {
    resolves([candidate({ callResponses: async () => stream(delta('hi'), completed('hi'), delta(' and more')) })]);

    const { facts } = await serve(true);
    const frames = withoutCarrier(await drain(facts['response.chat.responses.rendered']));

    expect(frames.map(frame => frame.event)).toEqual([
      'response.output_text.delta',
      'response.completed',
      undefined,
    ]);
  });

  // A stream that ran out before its terminal event is a turn nobody can answer from: the
  // response was never stated complete, incomplete or failed, so serving what did arrive
  // would report a truncated answer as a whole one. By then the client is already being
  // streamed to and the status went out with the headers, so it is told in the protocol's own
  // words — and the stream ends on that rather than on the terminator, because a stream that
  // ended on `[DONE]` is a stream that finished.
  it('tells a client already being streamed to that the stream never ended', async () => {
    resolves([candidate({ callResponses: async () => stream(delta('hi')) })]);

    const { facts } = await serve(true);
    const frames = await drain(facts['response.chat.responses.rendered']);

    expect(frames.map(frame => frame.event)).toEqual(['response.output_text.delta', 'error']);
    expect(JSON.parse(frames[1]!.data)).toMatchObject({
      type: 'error',
      error: { message: RESPONSES_MISSING_TERMINAL_MESSAGE },
    });
    // The client was answered, and the run still failed: what the frames said on the way out
    // is not what the row says the turn was.
    expect((await facts['response.chat.responses.streamedUsage']!).failed).toBe(true);
  });

  // The upstream speaks SSE whatever the client asked for, so a client that did not ask to
  // stream is answered from the same frames — folded here rather than read a second time.
  it('folds the frames into one response when the client did not', async () => {
    resolves([candidate({ callResponses: async () => stream(delta('he'), delta('llo'), completed('hello')) })]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(200);
    const answered = withoutCarrierItem(facts['response.chat.responses.rendered'] as unknown as ResponsesResult);
    expect(answered).toMatchObject({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: 'hello' }] }],
    });
    // One client response can span several upstream calls, so the envelope it is answered
    // under is the one the membrane minted rather than the one the upstream sent.
    expect(answered.id).not.toBe('resp_1');
  });

  // A compaction is one envelope rather than a stream: the upstream ran the turn, charged for
  // it, and stated the counts in the body. It rides at the same key the frames would have.
  it('serves an upstream that answered with one envelope as that envelope', async () => {
    const compaction: ResponsesCompactionResult = {
      id: 'resp_compact_1',
      object: 'response.compaction',
      output: [{
        type: 'message', id: 'msg_c', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'summary so far', annotations: [] }],
      }],
      usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 },
    };
    resolves([candidate({
      callResponses: async () => ({
        action: 'compact', ok: true, modelKey: 'responses-model-key', result: compaction,
      }),
    })]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.chat.responses.rendered']).toEqual(compaction);
    expect(facts['response.chat.responses.streamedUsage']).toBeNull();
    expect(facts['response.usage.billable']).toEqual([expect.objectContaining({
      quantities: { input_tokens: '900', output_tokens: '40' },
    })]);
  });

  // Content-length would misdescribe a body this gateway serialized itself; a vendor trace
  // is what a client and an operator both need to correlate a turn.
  it('forwards the upstream headers a client may see and drops the ones it may not', async () => {
    resolves([candidate({ callResponses: async () => stream(completed('hi')) })]);

    const { facts } = await serve(true);

    expect(Object.fromEntries(facts['response.http.headers'])).toMatchObject({ 'x-request-id': 'req-1' });
    expect(Object.fromEntries(facts['response.http.headers'])).not.toHaveProperty('content-length');
  });

  it('answers an upstream refusal with its own status and words', async () => {
    resolves([candidate({
      callResponses: async () => ({
        action: 'generate',
        ok: false,
        modelKey: 'responses-model-key',
        response: new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429, headers: { 'content-type': 'application/json' },
        }),
      }),
    })]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(429);
    expect(facts['response.chat.responses.rendered']).toEqual({ error: { message: 'slow down' } });
  });

  // A refused connection is an outcome the fork has to be able to see, not a fault that ends
  // the run — so the second candidate is tried and its answer is the one served.
  it('fails a dial that never connected over to the next candidate', async () => {
    const tried: string[] = [];
    resolves([
      candidate({ callResponses: async () => { tried.push('dead'); throw new Error('ECONNREFUSED'); } }, { upstreamId: 'up_dead' }),
      candidate({ callResponses: async () => { tried.push('alive'); return stream(completed('hi')); } }, { upstreamId: 'up_alive' }),
    ]);

    const { facts } = await serve(false);

    expect(tried).toEqual(['dead', 'alive']);
    expect(facts['response.http.status']).toBe(200);
  });

  // A provider owns the body it is dialled with and shapes it in place, down to nested nodes —
  // Copilot marks individual items for caching, and its Messages boundary writes into a nested
  // field — while the record that body is built from is deep-frozen. A dial that handed over a
  // shallow copy satisfies every type in the system and throws at the first nested write,
  // answering the client with a 502 raised where nothing can explain it.
  it('hands the provider a body it can write into, children included', async () => {
    resolves([candidate({
      callResponses: async (_model, body) => {
        const item = (body as { input: Record<string, unknown>[] }).input[0]!;
        item.copilot_cache_control = { type: 'ephemeral' };
        return stream(completed('hi'));
      },
    })]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(200);
  });

  // Codex asks for a compaction inside an ordinary turn, by ending its input with the control
  // item that requests one. Where the shim is this candidate's to run, that item never reaches
  // the upstream: what is sent instead is the compactor's own turn, and what comes back is an
  // envelope this gateway packed the summary into.
  it('answers a turn that asked for a compaction with one, where the shim is engaged', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = asksForCompaction;
    resolves([candidate(
      {
        callResponses: async (_model, body) => {
          sent = body as Record<string, unknown>;
          return stream(completed('CONDENSED SUMMARY'));
        },
      },
      { enabledFlags: new Set<FlagId>(['responses-compact-shim']) },
    )]);
    const gateway = mockChatGatewayCtx({ wantsStream: false });

    const { facts } = await serveWith(gateway, false, asksForCompaction);

    // The compactor's prompt reached the upstream, the item that asked for the compaction did
    // not, and the ephemeral summarization turn is not persisted in the upstream's history.
    expect(JSON.stringify(sent)).toContain('CONTEXT CHECKPOINT COMPACTION');
    expect(JSON.stringify(sent)).not.toContain('compaction_trigger');
    expect(sent).toMatchObject({ store: false });

    expect(facts['response.http.status']).toBe(200);
    const answered = facts['response.chat.responses.rendered'] as Record<string, unknown>;
    expect(answered.object).toBe('response.compaction');
    expect(await summaryIn(gateway, compactionItem(answered).encrypted_content)).toBe(`${SUMMARY_PREFIX}\nCONDENSED SUMMARY`);
  });

  // The flag says where a compaction would be simulated, not that this turn asked for one —
  // so an ordinary turn on an opted-in upstream is dialled as itself and answered as a
  // response, with nothing of the compactor's in the body that went out.
  it('dials an ordinary turn as itself, where the shim is engaged but nothing asked for one', async () => {
    let sent: Record<string, unknown> | undefined;
    resolves([candidate(
      {
        callResponses: async (_model, body) => {
          sent = body as Record<string, unknown>;
          return stream(completed('hello'));
        },
      },
      { enabledFlags: new Set<FlagId>(['responses-compact-shim']) },
    )]);

    const { facts } = await serve(false);

    expect(sent).toMatchObject({ input: [{ type: 'message', role: 'user', content: 'hi' }] });
    expect(JSON.stringify(sent)).not.toContain('CONTEXT CHECKPOINT COMPACTION');
    const answered = withoutCarrierItem(facts['response.chat.responses.rendered'] as unknown as ResponsesResult);
    expect(answered.object).toBe('response');
    expect(answered).toMatchObject({ output: [{ content: [{ type: 'output_text', text: 'hello' }] }] });
  });

  // The flag is the operator's opt-in, so an upstream that did not get it answers the item
  // itself: it reaches the wire as the client wrote it, and the compaction that comes back is
  // the upstream's own — its id, and a blob only it can read.
  it('sends a turn that asked for a compaction on unchanged, where the shim is not engaged', async () => {
    let sent: Record<string, unknown> | undefined;
    const upstreamCompaction: ResponsesCompactionResult = {
      id: 'resp_upstream_compaction',
      object: 'response.compaction',
      output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'OPAQUE_NATIVE_BLOB' } as unknown as never],
      usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 },
    };
    affinityPayload = asksForCompaction;
    resolves([candidate({
      callResponses: async (_model, body) => {
        sent = body as Record<string, unknown>;
        return { action: 'compact', ok: true, modelKey: 'responses-model-key', result: upstreamCompaction };
      },
    })]);

    const { facts } = await serve(false, asksForCompaction);

    expect(sent).toMatchObject({ input: [{ role: 'user' }, { type: 'compaction_trigger' }] });
    expect(JSON.stringify(sent)).not.toContain('CONTEXT CHECKPOINT COMPACTION');
    expect(facts['response.chat.responses.rendered']).toEqual(upstreamCompaction);
  });

  // No translation carries a compaction, and neither translator models the item that asks for
  // one — so on a candidate this protocol can only reach through one, the shim is structurally
  // required rather than opted into, and the flag has nothing to say.
  it('answers a turn that asked for a compaction over a candidate with no Responses wire', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    affinityPayload = asksForCompaction;
    resolves([candidate(
      { callMessages: messagesTurn('CONDENSED SUMMARY', seen) },
      { endpoints: { messages: {} } },
    )]);
    const gateway = mockChatGatewayCtx({ wantsStream: false });

    const { facts } = await serveWith(gateway, false, asksForCompaction);

    expect(JSON.stringify(seen.body)).toContain('CONTEXT CHECKPOINT COMPACTION');
    expect(JSON.stringify(seen.body)).not.toContain('compaction_trigger');
    const answered = facts['response.chat.responses.rendered'] as Record<string, unknown>;
    expect(answered.object).toBe('response.compaction');
    expect(await summaryIn(gateway, compactionItem(answered).encrypted_content)).toBe(`${SUMMARY_PREFIX}\nCONDENSED SUMMARY`);
  });

  // A compaction this gateway simulated carries the history it stood for, so an ordinary turn
  // that echoes one back is sent that history — the upstream has no key for the blob, and
  // would otherwise continue from nothing.
  it('expands a compaction it wrote before the turn quoting it goes out', async () => {
    let sent: Record<string, unknown> | undefined;
    const continues = {
      ...payload,
      input: [
        {
          type: 'compaction',
          id: 'cmp_prior',
          encrypted_content: encodeBase64UrlJson([
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'THE EARLIER HISTORY' }] },
          ]),
        },
        { type: 'message', role: 'user', content: 'and then?' },
      ],
    } as unknown as CanonicalResponsesPayload;
    affinityPayload = continues;
    resolves([candidate(
      {
        callResponses: async (_model, body) => {
          sent = body as Record<string, unknown>;
          return stream(completed('hi'));
        },
      },
      { enabledFlags: new Set<FlagId>(['responses-compact-shim']) },
    )]);

    await serve(false, continues);

    expect(JSON.stringify(sent)).toContain('THE EARLIER HISTORY');
    expect(JSON.stringify(sent)).not.toContain('cmp_prior');
  });

  // Only an upstream whose compactions this gateway simulates can be holding one of ours, and
  // an upstream that compacts natively is owed its own blob byte for byte — so where the shim
  // is not engaged the item travels as the client wrote it.
  it('leaves a compaction alone where the shim is not engaged', async () => {
    let sent: Record<string, unknown> | undefined;
    const encoded = encodeBase64UrlJson([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'THE EARLIER HISTORY' }] },
    ]);
    const continues = {
      ...payload,
      input: [{ type: 'compaction', id: 'cmp_prior', encrypted_content: encoded }],
    } as unknown as CanonicalResponsesPayload;
    affinityPayload = continues;
    resolves([candidate({
      callResponses: async (_model, body) => {
        sent = body as Record<string, unknown>;
        return stream(completed('hi'));
      },
    })]);

    await serve(false, continues);

    expect(sent).toMatchObject({ input: [{ type: 'compaction', id: 'cmp_prior', encrypted_content: encoded }] });
  });
});
