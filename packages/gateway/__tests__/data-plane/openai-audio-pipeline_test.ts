// OpenAI Audio Transcriptions' pipeline, assembled. `compose` derives the entry contract and
// rejects an array that cannot work, so most of what this file establishes is established
// by the module importing at all — the assembly runs at load. What is worth writing down is
// the entry contract it derives, the keys it cannot see, and the one runtime property this
// family's code is shaped around that no declaration expresses.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openaiAudioTranscriptionServePipeline } from '../../src/data-plane/openai-audio/pipeline.ts';
import { enumerateModelCandidates } from '../../src/data-plane/providers/resolution.ts';
import { initRepo } from '../../src/repo/index.ts';
import { mockGatewayCtx } from '../test-utils/gateway-ctx.ts';
import { isOwned, move, run } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import { directFetcher, type ModelCandidate, type ProviderCallResult } from '@floway-dev/provider';
import { stubInternalModel, stubProvider, stubProviderModel } from '@floway-dev/test-utils';

vi.mock('../../src/data-plane/providers/resolution.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/data-plane/providers/resolution.ts')>()),
  enumerateModelCandidates: vi.fn(),
}));

let live: readonly ModelCandidate[] = [];

const candidate = (callOpenAIAudioTranscriptions: () => Promise<ProviderCallResult>): ModelCandidate => {
  const endpoints = { openaiAudioTranscriptions: {} };
  return {
    provider: {
      upstreamId: 'up_a', kind: 'custom', name: 'up_a', inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null,
      instance: stubProvider({ callOpenAIAudioTranscriptions }),
    },
    model: stubInternalModel(
      { id: 'whisper-1', kind: 'transcription', endpoints, providerModels: { up_a: stubProviderModel({ id: 'whisper-1', endpoints }) } },
      'up_a',
    ),
    fetcher: directFetcher,
  } as unknown as ModelCandidate;
};

const resolves = (candidates: readonly ModelCandidate[]): void => {
  live = candidates;
  vi.mocked(enumerateModelCandidates).mockResolvedValue({ candidates, sawModel: true, failedUpstreams: [] } as never);
};

const sse = (...events: readonly string[]): Response =>
  new Response(events.map(event => `data: ${event}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const serve = async (responseFormat = 'json') => await run(
  openaiAudioTranscriptionServePipeline,
  move({
    'ingress.openaiAudioTranscription.responseFormat': responseFormat,
    'ingress.http.headers': [] as readonly (readonly [string, string])[],
    'request.openaiAudioTranscription.form': [{ name: 'model', value: 'whisper-1' }],
    'serve.model': 'whisper-1',
  }) as never,
  {
    gateway: mockGatewayCtx({ wantsStream: responseFormat === 'stream' }),
    background: () => {},
    rememberCandidates: () => {},
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

describe('the OpenAI Audio Transcriptions pipeline', () => {
  it('assembles, and asks its caller for what the descending stages need', () => {
    expect([...openaiAudioTranscriptionServePipeline.entryNeeds].sort()).toEqual([
      'ingress.openaiAudioTranscription.responseFormat',
      'serve.model',
    ]);
  });

  // The ending stage reads `request.openaiAudioTranscription.form` and `ingress.http.headers`,
  // and the entry contract mentions neither. That is not this family's defect: a stage whose
  // only trait is `return` declares no request side at all, by ruling — "when it
  // short-circuits, only `provides`" — so assembly cannot see what an ending stage reads.
  //
  // It bites harder here than it does for a family whose edge needs the request payload to
  // render: this family's edge does not, so the payload the whole endpoint exists to send is
  // among the keys assembly cannot ask for. A caller who omits it reaches the deepest stage
  // before failing. The type layer still catches it at the definition site, which is why this
  // is a gap and not a break.
  it('cannot see the request payload, because only a return-only stage reads it', () => {
    expect(openaiAudioTranscriptionServePipeline.entryNeeds).not.toContain('request.openaiAudioTranscription.form');
    expect(openaiAudioTranscriptionServePipeline.entryNeeds).not.toContain('ingress.http.headers');
  });

  it('names the entry key a caller did not bring, before any stage runs', async () => {
    await expect(run(openaiAudioTranscriptionServePipeline, move({ 'serve.model': 'whisper-1' }) as never, {}))
      .rejects.toThrow('run(openaiAudioTranscriptionServe): openaiAudioTranscriptionServe needs');
  });

  // The streamed answer is a wrapper around its generator rather than the generator itself.
  // That was once load-bearing: the runner detected ownership structurally, an async
  // generator carries `Symbol.asyncDispose`, and the sweep would have called it — which for
  // a generator is `return()`, cancelling the iteration rather than draining it.
  //
  // The runner now claims ownership through `own()` instead of detecting it, so a bare
  // generator is safe in the record. The wrapper stays because it says which thing is the
  // resource: the upstream body at `response.http.body`, and nothing else here.
  it('renders a transcription the upstream answered with, as a 200', async () => {
    resolves([candidate(async () => ({
      response: Response.json({ text: 'hello there' }),
      modelKey: 'whisper-key',
    } as ProviderCallResult))]);

    const { facts } = await serve();

    expect(facts['response.http.status']).toBe(200);
    expect(facts['response.openaiAudioTranscription.rendered']).toMatchObject({ text: 'hello there' });
  });

  // A refusal reaches the client with the status the upstream gave it, and in the words the
  // upstream used — the same statement every other family makes.
  it('answers an upstream refusal with its own status and words', async () => {
    resolves([candidate(async () => ({
      response: new Response(JSON.stringify({ error: { message: 'too large' } }), {
        status: 413, headers: { 'content-type': 'application/json' },
      }),
      modelKey: 'whisper-key',
    } as ProviderCallResult))]);

    const { facts } = await serve();

    expect(facts['response.http.status']).toBe(413);
    expect(facts['response.openaiAudioTranscription.rendered']).toEqual({ error: { message: 'too large' } });
  });

  // The reader stops at the terminal event. An upstream that holds the connection open past
  // it would otherwise hold the client's stream open with it, which is what the replaced
  // surface avoided by cancelling the moment the transcript was complete.
  it('stops reading a stream at its terminal event', async () => {
    const done = JSON.stringify({ type: 'transcript.text.done', text: 'hi', usage: { type: 'tokens', input_tokens: 3, output_tokens: 1 } });
    const after = JSON.stringify({ type: 'transcript.text.delta', delta: 'never read' });
    resolves([candidate(async () => ({
      response: sse(JSON.stringify({ type: 'transcript.text.delta', delta: 'hi' }), done, after),
      modelKey: 'whisper-key',
    } as ProviderCallResult))]);

    const { facts, drain } = await serve('json');
    const frames: SseFrame[] = [];
    for await (const frame of facts['response.openaiAudioTranscription.rendered'] as AsyncIterable<SseFrame>) frames.push(frame);
    await drain();

    expect(frames).toHaveLength(2);
    expect(frames.map(frame => JSON.parse(frame.data) as { type: string }).map(event => event.type))
      .toEqual(['transcript.text.delta', 'transcript.text.done']);
  });

  it('keeps the events view clear of what answers to release', () => {
    // Neither the generator nor the view around it is a resource. Whether the host marks a
    // generator disposable varies — Node 24 does, Node 22 does not — and the run's answer
    // does not, because ownership is claimed rather than read off the value.
    const generator = (async function* () { yield 1; })();
    expect(isOwned(generator)).toBe(false);
    expect(isOwned({ [Symbol.asyncIterator]: () => generator })).toBe(false);
  });
});
