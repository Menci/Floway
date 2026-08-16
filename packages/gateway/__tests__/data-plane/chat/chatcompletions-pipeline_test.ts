// The Chat Completions chain, run. Assembly is checked where every family's is; what is
// written down here is what only running it can say — that the edge folds a stream into one
// object when the client did not ask to stream, that a refusal keeps the upstream's own
// status and words, and that a dial nobody answered is a value the fork can move past.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { chatCompletionsServePipeline } from '../../../src/data-plane/chat/chat-completions/pipeline.ts';
import { enumerateModelCandidates } from '../../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { move, run } from '@floway-dev/pipeline';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { SseFrame } from '@floway-dev/protocols/common';
import { directFetcher, type ModelCandidate, type ProviderStreamResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

const candidate = (
  callChatCompletions: (model: unknown, body: unknown) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>,
  upstreamId = 'up_a',
): ModelCandidate => {
  const endpoints = { chatCompletions: {} };
  return {
    provider: {
      upstreamId, kind: 'custom', name: upstreamId, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callChatCompletions }),
    },
    model: stubInternalModel(
      { id: 'chat-model', endpoints, providerModels: { [upstreamId]: stubProviderModel({ id: 'chat-model', endpoints }) } },
      upstreamId,
    ),
    fetcher: directFetcher,
  } as unknown as ModelCandidate;
};

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] } as never);
};

const chunk = (text: string): ChatCompletionsStreamEvent => ({
  id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'chat-model',
  choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
});

const stream = (...events: readonly ChatCompletionsStreamEvent[]): ProviderStreamResult<ChatCompletionsStreamEvent> => ({
  ok: true,
  modelKey: 'chat-model-key',
  headers: new Headers({ 'x-request-id': 'req-1', 'content-length': '99' }),
  events: (async function* () {
    for (const event of events) yield { type: 'event' as const, event };
    yield { type: 'done' as const };
  })(),
});

const payload = { model: 'chat-model', messages: [{ role: 'user', content: 'hi' }] } as unknown as ChatCompletionsPayload;

/** What affinity materialized for the candidate about to be dialled. It differs from the
 *  payload the client sent, which is the point: carried state is rewritten per candidate. */
let affinityPayload: ChatCompletionsPayload = payload;

const serve = async (wantsStream: boolean) => await run(
  chatCompletionsServePipeline(payload),
  move({
    'ingress.http.headers': [] as readonly (readonly [string, string])[],
    'ingress.chat.sourceProtocol': 'chatCompletions',
    'ingress.chat.chatCompletions.wantsStream': wantsStream,
    'ingress.chat.chatCompletions.wantsUsageChunk': false,
    'request.chat.chatCompletions': payload,
    'serve.model': 'chat-model',
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

beforeEach(() => {
  vi.mocked(enumerateModelCandidates).mockReset();
  initRepo({
    usage: { record: async () => {} },
    performance: { recordNeutral: async () => {}, recordZeroOutputError: async () => {} },
  } as never);
});

describe('the chat completions chain', () => {
  // Affinity rewrites client-carried state for the upstream that will see it, so the body
  // that goes out is the one it materialized rather than the one the client sent.
  it('sends the payload affinity materialized for the candidate it dialled', async () => {
    let sent: Record<string, unknown> | undefined;
    affinityPayload = { ...payload, messages: [{ role: 'user', content: 'rewritten' }] } as ChatCompletionsPayload;
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
    for await (const frame of facts['response.chat.chatCompletions.rendered'] as AsyncIterable<SseFrame>) frames.push(frame);

    expect(facts['response.http.status']).toBe(200);
    expect(frames.map(frame => frame.data)).toEqual([
      JSON.stringify(chunk('he')),
      JSON.stringify(chunk('llo')),
      '[DONE]',
    ]);
  });

  // The upstream speaks SSE whatever the client asked for, so a client that did not ask to
  // stream is answered from the same frames — folded here rather than read a second time.
  it('folds the frames into one object when the client did not', async () => {
    resolves([candidate(async () => stream(chunk('he'), chunk('llo')))]);

    const { facts } = await serve(false);
    const rendered = facts['response.chat.chatCompletions.rendered'] as { choices: { message: { content: string } }[] };

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
    expect(facts['response.chat.chatCompletions.rendered']).toEqual({ error: { message: 'slow down' } });
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
