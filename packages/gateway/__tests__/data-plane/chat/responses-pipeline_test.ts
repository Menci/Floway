// The Responses chain, run. Assembly is checked where every family's is; what is written
// down here is what only running it can say — that the edge terminates the client's stream
// on `[DONE]` however the upstream's ended, that it folds a stream into one response object
// when the client did not ask to stream, that a turn the upstream answered with one envelope
// instead of a stream is served as that envelope, that a refusal keeps the upstream's own
// status and words, and that a dial nobody answered is a value the fork can move past.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { responsesServePipeline } from '../../../src/data-plane/chat/responses/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesCompactionResult, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { directFetcher, type ModelCandidate, type ProviderResponsesResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

const candidate = (
  callResponses: (model: unknown, body: unknown, action: unknown) => Promise<ProviderResponsesResult>,
  upstreamId = 'up_a',
): ModelCandidate => {
  const endpoints = { responses: {} };
  return {
    provider: {
      upstreamId, kind: 'custom', name: upstreamId, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callResponses }),
    },
    model: stubInternalModel(
      { id: 'responses-model', endpoints, providerModels: { [upstreamId]: stubProviderModel({ id: 'responses-model', endpoints }) } },
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

const payload = {
  model: 'responses-model',
  input: [{ type: 'message', role: 'user', content: 'hi' }],
} as unknown as CanonicalResponsesPayload;

/** What affinity materialized for the candidate about to be dialled. It differs from the
 *  payload the client sent, which is the point: carried state is rewritten per candidate. */
let affinityPayload: CanonicalResponsesPayload = payload;

const serve = async (wantsStream: boolean) => await run(
  responsesServePipeline(payload),
  move({
    'ingress.http.headers': [] as readonly (readonly [string, string])[],
    'ingress.chat.sourceProtocol': 'responses',
    'ingress.chat.responses.wantsStream': wantsStream,
    'request.chat.responses': payload,
    'serve.model': 'responses-model',
  }) as never,
  {
    gateway: mockChatGatewayCtx({ wantsStream }),
    background: () => {},
    rememberCandidates: () => {},
    rememberChatSelection: () => {},
    chatPayloadFor: () => affinityPayload,
    selectAffinity: () => {},
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

beforeEach(() => {
  affinityPayload = payload;
  vi.mocked(enumerateModelCandidates).mockReset();
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('the responses chain', () => {
  // Affinity rewrites client-carried state for the upstream that will see it, so the body
  // that goes out is the one it materialized rather than the one the client sent — and this
  // chain dials the generate action, whatever else the protocol can ask an upstream for.
  it('sends the payload affinity materialized for the candidate it dialled', async () => {
    let sent: Record<string, unknown> | undefined;
    let asked: unknown;
    affinityPayload = {
      ...payload,
      input: [{ type: 'message', role: 'user', content: 'rewritten' }],
    } as CanonicalResponsesPayload;
    resolves([candidate(async (_model, body, action) => {
      sent = body as Record<string, unknown>;
      asked = action;
      return stream(completed('hi'));
    })]);

    await serve(false);

    expect(sent).toMatchObject({ input: [{ type: 'message', role: 'user', content: 'rewritten' }] });
    expect(sent).not.toHaveProperty('model');
    expect(asked).toBe('generate');
  });

  // Every event goes out under its own SSE name, and the client's stream ends on the literal
  // `[DONE]` the transport reads as the turn being over.
  it('writes the frames out when the client asked to stream', async () => {
    resolves([candidate(async () => stream(delta('he'), delta('llo'), completed('hello')))]);

    const { facts } = await serve(true);
    const frames = await drain(facts['response.chat.responses.rendered']);

    expect(facts['response.http.status']).toBe(200);
    expect(frames.map(frame => frame.event)).toEqual([
      'response.output_text.delta',
      'response.output_text.delta',
      'response.completed',
      undefined,
    ]);
    expect(frames.map(frame => frame.data)).toEqual([
      JSON.stringify(delta('he')),
      JSON.stringify(delta('llo')),
      JSON.stringify(completed('hello')),
      '[DONE]',
    ]);
  });

  // A stream's numbers arrive with its last chunk, so what the run hands up is a promise and
  // the reading is taken off the frames the client itself drove.
  it('bills what the terminal event reported, once the frames have run out', async () => {
    resolves([candidate(async () => stream(
      delta('hi'),
      completed('hi', { input_tokens: 11, output_tokens: 7, total_tokens: 18 }),
    ))]);

    const { facts } = await serve(true);
    await drain(facts['response.chat.responses.rendered']);
    const billable = await facts['response.chat.responses.streamedUsage']!;

    expect(billable).toEqual([expect.objectContaining({
      quantities: { input_tokens: '11', output_tokens: '7' },
    })]);
  });

  // The upstream speaks SSE whatever the client asked for, so a client that did not ask to
  // stream is answered from the same frames — folded here rather than read a second time.
  it('folds the frames into one response when the client did not', async () => {
    resolves([candidate(async () => stream(delta('he'), delta('llo'), completed('hello')))]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.chat.responses.rendered']).toMatchObject({
      id: 'resp_1',
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: 'hello' }] }],
    });
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
    resolves([candidate(async () => ({
      action: 'compact', ok: true, modelKey: 'responses-model-key', result: compaction,
    }))]);

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
    resolves([candidate(async () => stream(completed('hi')))]);

    const { facts } = await serve(true);

    expect(Object.fromEntries(facts['response.http.headers'])).toMatchObject({ 'x-request-id': 'req-1' });
    expect(Object.fromEntries(facts['response.http.headers'])).not.toHaveProperty('content-length');
  });

  it('answers an upstream refusal with its own status and words', async () => {
    resolves([candidate(async () => ({
      action: 'generate',
      ok: false,
      modelKey: 'responses-model-key',
      response: new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429, headers: { 'content-type': 'application/json' },
      }),
    }))]);

    const { facts } = await serve(false);

    expect(facts['response.http.status']).toBe(429);
    expect(facts['response.chat.responses.rendered']).toEqual({ error: { message: 'slow down' } });
  });

  // A refused connection is an outcome the fork has to be able to see, not a fault that ends
  // the run — so the second candidate is tried and its answer is the one served.
  it('fails a dial that never connected over to the next candidate', async () => {
    const tried: string[] = [];
    resolves([
      candidate(async () => { tried.push('dead'); throw new Error('ECONNREFUSED'); }, 'up_dead'),
      candidate(async () => { tried.push('alive'); return stream(completed('hi')); }, 'up_alive'),
    ]);

    const { facts } = await serve(false);

    expect(tried).toEqual(['dead', 'alive']);
    expect(facts['response.http.status']).toBe(200);
  });
});
