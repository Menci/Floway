// Completions' pipeline, assembled and run. `compose` derives the entry contract and rejects
// an array that cannot work, so the assembly succeeding is itself most of what a test of the
// wiring would say — what is written down here is the entry contract, the two things the
// assembly cannot see, and one run of each shape the answer can take, because this is the
// first family whose answer can be a stream and none of that is visible in a declaration.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { completionsServePipeline } from '../../src/data-plane/completions/pipeline.ts';
import { enumerateModelCandidates } from '../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../src/repo/index.ts';
import { mockGatewayCtx } from '../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import { directFetcher, type ModelCandidate, type ProviderCallResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/data-plane/providers/resolution.ts')>()),
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

const candidate = (
  upstream: string,
  callCompletions: (model: unknown, body: unknown, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<ProviderCallResult>,
): ModelCandidate => {
  const endpoints = { chatCompletions: {}, completions: {} };
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callCompletions }),
    },
    model: stubInternalModel({ id: 'text-model', endpoints, providerModels: { [upstream]: stubProviderModel({ id: 'text-model', endpoints }) } }, upstream),
    fetcher: directFetcher,
  };
};

const sse = (...events: readonly string[]): Response =>
  new Response(events.map(event => `data: ${event}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const chunk = (text: string): string =>
  JSON.stringify({ id: 'cmpl_1', object: 'text_completion', created: 1, model: 'text-model', choices: [{ index: 0, text }] });

const usageChunk = JSON.stringify({
  id: 'cmpl_1', object: 'text_completion', created: 1, model: 'text-model', choices: [],
  usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
});

// Settlement is part of every serve pipeline now, and it writes. A test that drives a whole
// pipeline therefore needs somewhere for the row to go — the point being that the write
// happens at all, which is what "a run that measured rather than generated still writes"
// means and what nothing was checking before.
const recorded: { usage: unknown[]; performance: unknown[] } = { usage: [], performance: [] };

beforeEach(() => {
  recorded.usage = [];
  recorded.performance = [];
  initRepo({
    usage: { record: async (row: unknown) => { recorded.usage.push(row); } },
    performance: {
      recordNeutral: async (dims: unknown) => { recorded.performance.push(dims); },
      recordZeroOutputError: async (dims: unknown) => { recorded.performance.push(dims); },
    },
  } as never);
});

const serve = async (facts: Record<string, unknown>) => await run(
  completionsServePipeline,
  move(facts) as never,
  {
    gateway: mockGatewayCtx({ wantsStream: facts['ingress.completions.wantsStream'] === true }),
    background: () => {},
    resolveAttempt,
  } as never,
);

const entryFacts = (overrides: Record<string, unknown> = {}) => ({
  'ingress.completions.wantsStream': true,
  'ingress.completions.wantsUsageChunk': false,
  'ingress.http.headers': [],
  'request.completions.payload': { model: 'text-model', prompt: 'hello', stream: true },
  'serve.model': 'text-model',
  ...overrides,
});

const collect = async (rendered: unknown): Promise<readonly SseFrame[]> => {
  const frames: SseFrame[] = [];
  for await (const frame of rendered as AsyncIterable<SseFrame>) frames.push(frame);
  return frames;
};

beforeEach(() => { vi.mocked(enumerateModelCandidates).mockReset(); });

describe('the completions pipeline', () => {
  it('assembles, and asks its caller for what the descending stages need', () => {
    expect([...completionsServePipeline.entryNeeds].sort()).toEqual([
      'ingress.completions.wantsStream',
      'ingress.completions.wantsUsageChunk',
      'request.completions.payload',
      'serve.model',
    ]);
  });

  // `callCompletionsUpstream` reads `ingress.http.headers`, and the entry contract does not
  // mention it. That is not this family's defect: a stage whose only trait is `return`
  // declares no request side at all, by ruling — "when it short-circuits, only `provides`" —
  // so assembly cannot see what an ending stage reads, and every family's ending stage reads
  // something. A caller who omits that key gets a runtime failure at the deepest stage
  // instead of the assembly error the entry contract exists to give it.
  it('cannot see what an ending stage reads, because a return-only stage declares no needs', () => {
    expect(completionsServePipeline.entryNeeds).not.toContain('ingress.http.headers');
  });

  it('renders the upstream frames as SSE, hiding the usage chunk the client did not ask for', async () => {
    let sent: Record<string, unknown> | undefined;
    resolves([candidate('up_a', async (_model, body) => {
      sent = body as Record<string, unknown>;
      return { response: sse(chunk('he'), chunk('llo'), usageChunk, '[DONE]'), modelKey: 'text-model-key' };
    })]);

    const { facts, drain } = await serve(entryFacts());

    // The answer comes back before the drain runs, which is what lets a streaming family
    // hand its stream on: the frames are still there to read.
    expect(await collect(facts['response.completions.rendered'])).toEqual([
      { type: 'sse', event: undefined, data: chunk('he') },
      { type: 'sse', event: undefined, data: chunk('llo') },
      { type: 'sse', event: undefined, data: '[DONE]' },
    ]);
    // Metering is the gateway's, not the client's: the upstream is always asked for the
    // chunk the client is not shown.
    expect(sent).toMatchObject({ stream_options: { include_usage: true } });
    expect(sent).not.toHaveProperty('model');
    await drain();
  });

  it('says the upstream was called and reported nothing until the frames run out', async () => {
    resolves([candidate('up_a', async () => ({ response: sse(chunk('hi'), usageChunk, '[DONE]'), modelKey: 'text-model-key' }))]);

    const { facts, drain } = await serve(entryFacts());

    // What is known when the ending stage hands up: an entity, and no quantities. The
    // numbers arrive with the last chunk, which is after this run has answered.
    expect(facts['response.usage.billable']).toEqual([
      { identity: { model: 'text-model', upstream: 'up_a', modelKey: 'text-model-key', pricing: null }, quantities: {} },
    ]);
    await collect(facts['response.completions.rendered']);
    expect(await facts['response.completions.streamedUsage']).toEqual([
      {
        identity: { model: 'text-model', upstream: 'up_a', modelKey: 'text-model-key', pricing: null },
        quantities: { input_tokens: '5', output_tokens: '7' },
      },
    ]);
    await drain();
  });

  it('shows the usage chunk to a client that asked for it', async () => {
    resolves([candidate('up_a', async () => ({ response: sse(chunk('hi'), usageChunk, '[DONE]'), modelKey: 'text-model-key' }))]);

    const { facts, drain } = await serve(entryFacts({ 'ingress.completions.wantsUsageChunk': true }));

    expect((await collect(facts['response.completions.rendered'])).map(frame => frame.data)).toEqual([chunk('hi'), usageChunk, '[DONE]']);
    await drain();
  });

  it('serializes a non-streaming answer from the value it parsed, and bills what it read', async () => {
    const body = { id: 'cmpl_1', object: 'text_completion', created: 1, model: 'text-model', choices: [{ index: 0, text: 'hi', finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } };
    resolves([candidate('up_a', async () => ({ response: Response.json(body), modelKey: 'text-model-key' }))]);

    const { facts, drain } = await serve(entryFacts({
      'ingress.completions.wantsStream': false,
      'request.completions.payload': { model: 'text-model', prompt: 'hello' },
    }));

    expect(facts['response.completions.rendered']).toEqual(body);
    expect(facts['response.completions.streamedUsage']).toBeNull();
    expect(facts['response.usage.billable']).toEqual([
      {
        identity: { model: 'text-model', upstream: 'up_a', modelKey: 'text-model-key', pricing: null },
        quantities: { input_tokens: '5', output_tokens: '7' },
      },
    ]);
    await drain();
  });

  // Ownership is claimed, never detected, and until the claim was made the whole mechanism
  // was inert: `failover` declared it consumes the body, `drain()` existed, and no family
  // ever marked a body — so a losing attempt's connection stayed open and the winner's was
  // never drained. This is the property, not the absence of the bug.
  it('drains the losing attempt-s body at the fork, and the winner-s at the drain', async () => {
    const drained: string[] = [];
    const body = (label: string, chunks: readonly string[]): ReadableStream<Uint8Array> => {
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull: controller => {
          if (index < chunks.length) { controller.enqueue(new TextEncoder().encode(chunks[index]!)); index += 1; return; }
          drained.push(label);
          controller.close();
        },
      });
    };
    resolves([
      candidate('up_a', async () => ({
        response: new Response(body('loser', []), { status: 429, headers: { 'content-type': 'application/json' } }),
        modelKey: 'k',
      })),
      candidate('up_b', async () => ({
        response: new Response(body('winner', [`data: ${chunk('hi')}\n\n`, 'data: [DONE]\n\n']), {
          status: 200, headers: { 'content-type': 'text/event-stream' },
        }),
        modelKey: 'k',
      })),
    ]);

    const { facts, drain } = await serve(entryFacts());
    // The client's stream is still live: the run answered before anything was drained.
    expect(facts['response.completions.rendered']).toBeDefined();
    await drain();
    expect(drained).toContain('winner');
  });

  // Settlement is above the fork, so a run bills once however many candidates it tried —
  // and it is unconditional, so a run that reached no upstream still writes a row that names
  // no billed entity. Nothing asserted either until the review found the stage was composed
  // into no pipeline at all.
  it('writes exactly one usage row per run, however many candidates it tried', async () => {
    resolves([
      candidate('up_a', async () => ({ response: Response.json({ error: 'nope' }, { status: 429 }), modelKey: 'k' })),
      candidate('up_b', async () => ({ response: sse(chunk('hi'), usageChunk, '[DONE]'), modelKey: 'k' })),
    ]);
    const { drain } = await serve(entryFacts());
    await drain();
    expect(recorded.usage).toHaveLength(1);
    expect(recorded.performance).toHaveLength(1);
  });

  // A run that reached no upstream bills nothing and samples nothing, which is what the
  // replaced surface did: `recordPerformance` returns early without an attempt's telemetry,
  // and there is no attempt. Settlement still runs — it is unconditional — and finds an
  // empty billed set, which is how "we did not call an upstream" is said.
  it('bills nothing and samples nothing when no upstream was reached', async () => {
    vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates: [], sawModel: false, failedUpstreams: [] });
    await serve(entryFacts());
    expect(recorded.usage).toHaveLength(0);
    expect(recorded.performance).toHaveLength(0);
  });

  it('fails a refusal over to the next candidate, and renders the last one it got', async () => {
    const tried: string[] = [];
    resolves([
      candidate('up_a', async () => {
        tried.push('up_a');
        return { response: Response.json({ error: { message: 'slow down' } }, { status: 429 }), modelKey: 'text-model-key' };
      }),
      candidate('up_b', async () => {
        tried.push('up_b');
        return { response: Response.json({ error: { message: 'no' } }, { status: 400 }), modelKey: 'text-model-key' };
      }),
    ]);

    const { facts, drain } = await serve(entryFacts({
      'ingress.completions.wantsStream': false,
      'request.completions.payload': { model: 'text-model', prompt: 'hello' },
    }));

    expect(tried).toEqual(['up_a', 'up_b']);
    // Every candidate failed, so the last failure is the base — the client sees the status
    // an upstream actually returned rather than a synthesized gateway envelope.
    expect(facts['response.http.status']).toBe(400);
    expect(facts['response.completions.rendered']).toEqual({ error: { message: JSON.stringify({ error: { message: 'no' } }), type: 'api_error' } });
    await drain();
  });

  // Nothing in this family's own declarations says it must hand the upstream's body up, and
  // nothing in assembly checks it: `failover` declares `provides: ['response.http.body']` on
  // the way up, and that declaration is checked by the runner, at runtime, against whatever
  // the stage below it handed on. A family whose ending stage parses the body and keeps it —
  // which is what "no body is forwarded verbatim" invites — composes cleanly and then throws
  // on its first request. The cast is the other half of the same story: the key rides in the
  // record without being in the pipeline's exit type, because the path that refuses before
  // any upstream is dialed has no body to hand up.
  it('hands the upstream body up, because failover declares it provides one', async () => {
    resolves([candidate('up_a', async () => ({ response: sse(chunk('hi'), '[DONE]'), modelKey: 'text-model-key' }))]);

    const { facts, drain } = await serve(entryFacts());

    expect((facts as Record<string, unknown>)['response.http.body']).toBeInstanceOf(ReadableStream);
    await collect(facts['response.completions.rendered']);
    await drain();
  });
});
