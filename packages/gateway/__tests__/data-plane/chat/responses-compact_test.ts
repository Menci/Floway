// The Responses compaction chain, run. Assembly is checked where every family's is; what is
// written down here is what only running it can say — that an upstream whose own endpoint
// compacts is asked to and answered under an id this gateway minted, that one with no
// compaction wire is sent the compactor's turn over the wires generation would have used and
// answered with an envelope of this gateway's own, that a prior simulated compaction the
// client echoed back is expanded before the history is summarized, that a summarization
// producing nothing is a candidate the fork moves past, and that a compaction whose turn
// failed settles as a failure.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SUMMARY_PREFIX } from '../../../src/data-plane/chat/responses/compact-shim.ts';
import { responsesCompactPipeline } from '../../../src/data-plane/chat/responses/compact.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../src/shared/base64url-json.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { CanonicalResponsesPayload, ResponsesCompactionResult, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
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

const USAGE = { input_tokens: 12, output_tokens: 3, total_tokens: 15 };

/** What a native compaction upstream answers with: `CompactResource` states no `status`, no
 *  `model` and no `error`. */
const compaction = (overrides: Partial<ResponsesCompactionResult> = {}): ResponsesCompactionResult => ({
  id: 'resp_upstream_compaction',
  object: 'response.compaction',
  output: [{ type: 'compaction', id: 'cmp_1', encrypted_content: 'OPAQUE_NATIVE_BLOB' } as unknown as never],
  usage: USAGE,
  ...overrides,
});

const compacts = (
  seen: { body?: Record<string, unknown>; action?: unknown },
  overrides: Partial<ResponsesCompactionResult> = {},
) => async (_model: unknown, body: unknown, action: unknown): Promise<ProviderResponsesResult> => {
  seen.body = body as Record<string, unknown>;
  seen.action = action;
  return { action: 'compact', ok: true, result: compaction(overrides), modelKey: 'responses-model-key' };
};

/** A generate turn over the Responses wire that produces one assistant message. */
const generates = (text: string, seen: { body?: Record<string, unknown>; action?: unknown } = {}) =>
  async (_model: unknown, body: unknown, action: unknown): Promise<ProviderResponsesResult> => {
    seen.body = body as Record<string, unknown>;
    seen.action = action;
    const response: ResponsesResult = {
      id: 'resp_summary',
      object: 'response',
      model: 'responses-model',
      status: 'completed',
      output: [{
        type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      }],
      error: null,
      incomplete_details: null,
      usage: USAGE,
    };
    return {
      action: 'generate', ok: true, modelKey: 'responses-model-key', headers: new Headers(),
      events: (async function* () {
        yield { type: 'event' as const, event: { type: 'response.completed', sequence_number: 0, response } as ResponsesStreamEvent };
        yield { type: 'done' as const };
      })(),
    };
  };

/** The same turn over the Messages wire, which is the only way a Messages-only candidate can
 *  be reached: the compaction crosses into that protocol and its frames come back translated. */
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
  input: [{ type: 'message', role: 'user', content: 'a long conversation' }],
  store: false,
} as unknown as CanonicalResponsesPayload;

const settlements: { billable: unknown; failed: boolean }[] = [];

let gateway = mockChatGatewayCtx({ wantsStream: false });

const compact = async (request: CanonicalResponsesPayload = payload) => {
  gateway = mockChatGatewayCtx({ wantsStream: false });
  const outcome = await run(
    responsesCompactPipeline(request),
    move({
      'ingress.http.headers': [] as readonly (readonly [string, string])[],
      'ingress.chat.sourceProtocol': 'responses',
      'request.chat.responses': request,
      'serve.model': request.model,
    }) as never,
    {
      gateway,
      background: () => {},
      rememberCandidates: () => {},
      rememberChatSelection: () => {},
      chatPayloadFor: () => request,
      selectAffinity: (selected: ModelCandidate) => { gateway.affinity.select(selected); },
      resolveAttempt: (selector: { readonly upstreamId: string }) => {
        const found = live.find(c => c.provider.upstreamId === selector.upstreamId);
        if (found === undefined) throw new Error(`no live candidate for ${selector.upstreamId}`);
        return found;
      },
    } as never,
  );
  // What the epilogue would settle from, once the run has answered.
  const pending = outcome.facts['response.chat.responses.streamedUsage'];
  if (pending !== null) settlements.push(await pending);
  return outcome;
};

const rendered = (facts: Record<string, unknown>): Record<string, unknown> =>
  facts['response.chat.responses.rendered'] as Record<string, unknown>;

/** The summary a simulated compaction packed into the item the client is handed. The turn's
 *  own state is sealed around it on the way out — that is what pins the next turn to the
 *  upstream that issued this one — so the carrier is opened before the blob is read. */
const summaryIn = async (encryptedContent: string): Promise<string> => {
  const carrier = await gateway.affinity.codec.unwrap(encryptedContent, 'responses.compaction.encrypted_content');
  if (carrier.kind !== 'owned' || carrier.value === undefined) throw new Error('expected the turn-s own carrier around the blob');
  const items = decodeBase64UrlJson(carrier.value) as { content: { text: string }[] }[] | null;
  if (items === null) throw new Error('expected a shim-encoded compaction blob');
  return items[0]!.content[0]!.text;
};

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  settlements.length = 0;
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
    responsesSnapshots: { lookup: async () => null, put: async () => {} },
    responsesItems: { lookupMany: async () => [], putMany: async () => {} },
  } as never);
});

describe('the responses compaction chain', () => {
  // An upstream whose own endpoint compacts is asked to compact. What comes back is expanded
  // into the events the stateful half reads, which is what replaces the upstream's response id
  // with one this gateway minted and completes the resource this endpoint answers with.
  it('dials a compaction, and answers the compaction resource under its own id', async () => {
    const seen: { body?: Record<string, unknown>; action?: unknown } = {};
    resolves([candidate({ callResponses: compacts(seen) })]);

    const { facts } = await compact();

    expect(seen.action).toBe('compact');
    expect(facts['response.http.status']).toBe(200);
    expect(rendered(facts).object).toBe('response.compaction');
    expect(rendered(facts).id).not.toBe('resp_upstream_compaction');
    expect(rendered(facts).created_at).toBeTypeOf('number');
    expect(rendered(facts).usage).toMatchObject({ input_tokens: 12, output_tokens: 3, total_tokens: 15 });
    // A compaction is not a response resource, so none of the twenty-odd keys that one
    // requires is decorated onto it.
    expect(rendered(facts)).not.toHaveProperty('tools');
    expect(rendered(facts)).not.toHaveProperty('truncation');
  });

  // Neither field belongs on the compaction endpoint: `store` is a gateway-only snapshot hint
  // it rejects, and `stream` describes a delivery this operation does not make.
  it('sends neither store nor stream on the compaction wire', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    resolves([candidate({ callResponses: compacts(seen) })]);

    await compact({ ...payload, stream: false } as unknown as CanonicalResponsesPayload);

    expect(seen.body).not.toHaveProperty('store');
    expect(seen.body).not.toHaveProperty('stream');
    expect(seen.body).not.toHaveProperty('model');
  });

  // No translation carries a compaction, so a Messages candidate has none to dial. The turn
  // it is sent instead is an ordinary generate turn against the compactor's prompt, over the
  // wire generation would have used — which is the whole of what the action pivot was.
  it('simulates a compaction over a candidate with no compaction wire', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    resolves([candidate({ callMessages: messagesTurn('CONDENSED SUMMARY', seen) }, { endpoints: { messages: {} } })]);

    const { facts } = await compact({
      ...payload,
      input: [
        { type: 'message', role: 'user', content: 'real history' },
        { type: 'compaction_trigger' },
      ],
    } as unknown as CanonicalResponsesPayload);

    // The compactor's prompt reached the upstream, and the control item that asked for the
    // compaction did not.
    const sent = JSON.stringify(seen.body);
    expect(sent).toContain('CONTEXT CHECKPOINT COMPACTION');
    expect(sent).not.toContain('compaction_trigger');

    expect(facts['response.http.status']).toBe(200);
    expect(rendered(facts).object).toBe('response.compaction');
    const output = rendered(facts).output as { type: string; encrypted_content: string }[];
    expect(output[0]!.type).toBe('compaction');
    expect(await summaryIn(output[0]!.encrypted_content)).toBe(`${SUMMARY_PREFIX}\nCONDENSED SUMMARY`);
  });

  // The flag is the operator's opt-in for an upstream that would answer a compaction itself.
  it('simulates rather than dials when the operator asked it to', async () => {
    const seen: { body?: Record<string, unknown>; action?: unknown } = {};
    resolves([candidate(
      { callResponses: generates('SIMULATED SUMMARY', seen) },
      { enabledFlags: new Set<FlagId>(['responses-compact-shim']) },
    )]);

    const { facts } = await compact();

    expect(seen.action).toBe('generate');
    // The ephemeral summarization turn is not persisted in the upstream's own history.
    expect(seen.body).toMatchObject({ store: false });
    expect(rendered(facts).object).toBe('response.compaction');
    const output = rendered(facts).output as { encrypted_content: string }[];
    expect(await summaryIn(output[0]!.encrypted_content)).toBe(`${SUMMARY_PREFIX}\nSIMULATED SUMMARY`);
  });

  // A compaction this gateway synthesized carries the history it stood for, so a turn that
  // echoes it back is summarized from that history rather than from an opaque blob.
  it('expands a compaction it wrote before summarizing again', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const encoded = encodeBase64UrlJson([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'THE EARLIER HISTORY' }] },
    ]);
    resolves([candidate(
      { callResponses: generates('S', seen) },
      { enabledFlags: new Set<FlagId>(['responses-compact-shim']) },
    )]);

    await compact({
      ...payload,
      input: [{ type: 'compaction', id: 'cmp_prior', encrypted_content: encoded }],
    } as unknown as CanonicalResponsesPayload);

    expect(JSON.stringify(seen.body)).toContain('THE EARLIER HISTORY');
  });

  // The blob is the whole of what the next turn inherits, so a summarization that closed no
  // text produced nothing to inherit — a candidate that did not do the job rather than a
  // fault that ends the request.
  it('fails a summarization that produced no text over to the next candidate', async () => {
    const tried: string[] = [];
    resolves([
      candidate(
        { callResponses: async (...args) => { tried.push('mute'); return await generates('')(...args as [unknown, unknown, unknown]); } },
        { upstreamId: 'up_mute', enabledFlags: new Set<FlagId>(['responses-compact-shim']) },
      ),
      candidate(
        { callResponses: async (...args) => { tried.push('talkative'); return await generates('A SUMMARY')(...args as [unknown, unknown, unknown]); } },
        { upstreamId: 'up_talkative', enabledFlags: new Set<FlagId>(['responses-compact-shim']) },
      ),
    ]);

    const { facts } = await compact();

    expect(tried).toEqual(['mute', 'talkative']);
    expect(facts['response.http.status']).toBe(200);
    expect(rendered(facts).object).toBe('response.compaction');
  });

  it('fails a refused compaction over to the next candidate, and keeps the last refusal-s own status', async () => {
    resolves([
      candidate({
        callResponses: async (): Promise<ProviderResponsesResult> => ({
          action: 'compact', ok: false, modelKey: 'k',
          response: new Response(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit' } }), {
            status: 429, headers: { 'content-type': 'application/json' },
          }),
        }),
      }, { upstreamId: 'up_busy' }),
      candidate({
        callResponses: async (): Promise<ProviderResponsesResult> => ({
          action: 'compact', ok: false, modelKey: 'k',
          response: new Response(JSON.stringify({ error: { message: 'still no', type: 'rate_limit' } }), {
            status: 503, headers: { 'content-type': 'application/json' },
          }),
        }),
      }, { upstreamId: 'up_busier' }),
    ]);

    const { facts } = await compact();

    expect(facts['response.http.status']).toBe(503);
    expect(rendered(facts)).toEqual({ error: { message: 'still no', type: 'rate_limit' } });
  });

  // `Usage` has no `null` alternative on this resource and zeros are not its spelling, so an
  // upstream that stated no counts has left the gateway unable to answer.
  it('reports a compaction the upstream stated no counts for as the gateway-s own failure', async () => {
    resolves([candidate({ callResponses: compacts({}, { usage: undefined }) })]);

    const { facts } = await compact();

    expect(facts['response.http.status']).toBe(502);
    const body = rendered(facts).error as { type: string; message: string };
    expect(body.type).toBe('internal_error');
    expect(body.message).toContain('reported no token usage');
  });

  // `status` is not a key the compaction resource declares — it rides through from the turn
  // the upstream actually ran — and a compaction that surfaced as failed belongs in the error
  // column rather than masquerading as a success.
  it('settles a compaction whose turn failed as a failure', async () => {
    resolves([candidate({ callResponses: compacts({}, { status: 'failed' } as Partial<ResponsesCompactionResult>) })]);

    await compact();

    expect(settlements).toEqual([{ billable: expect.anything(), failed: true }]);
  });

  it('settles a compaction that ran as a success, billing what its envelope stated', async () => {
    resolves([candidate({ callResponses: compacts({}) })]);

    await compact();

    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.failed).toBe(false);
    expect(settlements[0]!.billable).toMatchObject([
      { quantities: { input_tokens: '12', output_tokens: '3' } },
    ]);
  });

  // A provider owns the body it is dialled with and shapes it in place, down to nested nodes —
  // Copilot marks individual items for caching — while the record that body is built from is
  // deep-frozen. A dial that handed over a shallow copy throws at the first nested write, and
  // this operation would answer 502 where the upstream had said nothing at all.
  it('hands the provider a body it can write into, children included', async () => {
    resolves([candidate({
      callResponses: async (model, body, action) => {
        const item = (body as { input: Record<string, unknown>[] }).input[0]!;
        item.copilot_cache_control = { type: 'ephemeral' };
        return await compacts({})(model, body, action);
      },
    })]);

    const { facts } = await compact();

    expect(facts['response.http.status']).toBe(200);
  });
});
