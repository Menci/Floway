import { describe, expect, it } from 'vitest';

import {
  computeStageDiffs,
  createDumpDecoder,
  createDumpPump,
  defineRequestStage,
  defineStage,
  dispatch,
  formatCurlCommand,
  getStreamLineage,
  handoff,
  pipeline,
  projectWireView,
  runPipeline,
  secret,
  terminal,
} from '../src/index.ts';
import type { HeaderEntry, ManagedStream, Secret, WireRequestSnapshot, WireResponseSnapshot } from '../src/index.ts';

interface DownstreamIn {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.chat': {
    readonly model: string;
    readonly messages: { readonly role: string; readonly content: string }[];
  };
}

interface Candidate {
  readonly upstreamId: string;
  readonly kind: string;
  readonly modelId: string;
  readonly upstreamModelId: string;
}

describe('pipeline + dump v2 + wire projection end-to-end', () => {
  it('streams NDJSON dump chunks across failover, sub-run, secret redaction, stage diffs, and 4-face wire projection', async () => {
    const encoder = new TextEncoder();
    const decoderUtf8 = new TextDecoder();
    const apiKey: Secret<string> = secret('sk-live-super-secret-upstream-token');

    // Sub-run pipeline (e.g. web_search hosted tool)
    const searchSubPipeline = pipeline<{ query: string }>('sub.web-search')
      .use(defineRequestStage<{ query: string }, { 'request.http': WireRequestSnapshot }>({
        name: 'build-search-http',
        execute: async (facts, next) => await next({
          'request.http': {
            method: 'POST',
            url: { origin: 'https://search.example.com', pathname: '/v1/search', query: [['key', apiKey], ['hl', 'en']] },
            headers: [['content-type', 'application/json']],
            body: { q: facts.query },
          },
        }),
      }))
      .end(terminal<{ 'request.http': WireRequestSnapshot }, WireResponseSnapshot>({
        name: 'http.search',
        tap: 'upstream',
        execute: async () => ({
          status: 200,
          statusText: 'OK',
          headers: [['content-type', 'application/json']],
          body: { hits: ['Floway V2'] },
          timing: { startedAtMs: 5, headersAtMs: 8 },
        }),
      }));

    // Provider pipeline ending in upstream HTTP terminal
    let attemptCounter = 0;
    const providerPipeline = pipeline<{ 'route.candidate': Candidate; payload: { model: string; text: string } }>('provider.custom')
      .use(defineRequestStage<
        { 'route.candidate': Candidate; payload: { model: string; text: string } },
        { 'request.http': WireRequestSnapshot }
      >({
        name: 'provider.build-http',
        execute: async (facts, next) => await next({
          'request.http': {
            method: 'POST',
            url: {
              origin: 'https://api.upstream.example',
              pathname: '/v1/messages',
              query: [['beta', 'true'], ['api_key', apiKey]],
            },
            headers: [
              ['authorization', apiKey],
              ['content-type', 'application/json'],
            ] satisfies readonly HeaderEntry[],
            body: facts.payload,
          },
        }),
      }))
      .end(terminal<{ 'route.candidate': Candidate; 'request.http': WireRequestSnapshot }, {
        readonly status: number;
        readonly statusText: string;
        readonly headers: readonly HeaderEntry[];
        readonly body: ManagedStream<Uint8Array>;
        readonly timing: { readonly startedAtMs: number; readonly headersAtMs: number };
      }>({
        name: 'http.terminal',
        tap: 'upstream',
        execute: async (_facts, env) => {
          attemptCounter++;
          if (attemptCounter === 1) {
            return {
              status: 503,
              statusText: 'Service Unavailable',
              headers: [['content-type', 'application/json']],
              body: env.createStream({
                label: 'http.body',
                async *iterate() {
                  yield encoder.encode('{"error":"overloaded"}');
                },
              }),
              timing: { startedAtMs: 2, headersAtMs: 4 },
            };
          }
          return {
            status: 200,
            statusText: 'OK',
            headers: [['content-type', 'text/event-stream']],
            body: env.createStream({
              label: 'http.body',
              async *iterate() {
                yield encoder.encode('data: {"delta":"Hello "}\n\n');
                yield encoder.encode('data: {"delta":"Floway"}\n\n');
              },
            }),
            timing: { startedAtMs: 10, headersAtMs: 14 },
          };
        },
      }));

    // Serve pipeline: downstream edge -> subrun + failover -> protocol decode -> dispatch
    const servePipeline = pipeline<DownstreamIn>('serve.messages')
      .use(defineStage<
        DownstreamIn,
        Record<never, never>,
        { events: ManagedStream<{ delta: string }> },
        { status: number; headers: readonly HeaderEntry[]; body: ManagedStream<Uint8Array> }
      >({
        name: 'edge.downstream',
        tap: 'downstream',
        execute: async (_facts, next, env) => {
          const inner = await next();
          const sseBytes = env.wrapStream(inner.events, {
            label: 'sse.bytes',
            async *transform(source) {
              for await (const ev of source) {
                yield encoder.encode(`event: delta\ndata: ${JSON.stringify(ev)}\n\n`);
              }
            },
          });
          return {
            status: 200,
            headers: [['content-type', 'text/event-stream']],
            body: sseBytes,
          };
        },
      }))
      .use(defineStage<
        DownstreamIn,
        { 'route.candidate': Candidate; searchContext: string },
        { events: ManagedStream<{ delta: string }> },
        { events: ManagedStream<{ delta: string }> }
      >({
        name: 'route.failover',
        execute: async (_facts, next, env) => {
          const searchRes = await env.spawnSubRun(searchSubPipeline, { query: 'pipeline v2' });
          const hits = (searchRes.body as { hits: string[] }).hits.join(',');
          const candidates: Candidate[] = [
            { upstreamId: 'up-1', kind: 'custom', modelId: 'claude', upstreamModelId: 'claude-1' },
            { upstreamId: 'up-2', kind: 'custom', modelId: 'claude', upstreamModelId: 'claude-2' },
          ];
          let lastError: unknown;
          for (const candidate of candidates) {
            try {
              return await next({ 'route.candidate': candidate, searchContext: hits });
            } catch (err) {
              lastError = err;
            }
          }
          throw lastError;
        },
      }))
      .use(defineStage<
        DownstreamIn & { 'route.candidate': Candidate; searchContext: string },
        { payload: { model: string; text: string } },
        {
          readonly status: number;
          readonly statusText: string;
          readonly headers: readonly HeaderEntry[];
          readonly body: ManagedStream<Uint8Array>;
        },
        { events: ManagedStream<{ delta: string }> }
      >({
        name: 'codec.parse-sse',
        execute: async (facts, next, env) => {
          const upstream = await next({
            payload: {
              model: facts['route.candidate'].upstreamModelId,
              text: `${facts['request.chat'].messages[0]!.content} [${facts.searchContext}]`,
            },
          });
          if (upstream.status !== 200) {
            await env.discard(upstream.body, 'upstream-503');
            throw new Error(`Upstream status ${upstream.status}`);
          }
          const events = env.wrapStream(upstream.body, {
            label: 'protocol.events',
            async *transform(source) {
              for await (const chunk of source) {
                const line = decoderUtf8.decode(chunk).trim();
                const json = line.replace(/^data:\s*/, '');
                yield JSON.parse(json) as { delta: string };
              }
            },
          });
          return { events };
        },
      }))
      .end(dispatch<
        { 'route.candidate': Candidate; payload: { model: string; text: string } },
        {
          readonly status: number;
          readonly statusText: string;
          readonly headers: readonly HeaderEntry[];
          readonly body: ManagedStream<Uint8Array>;
        }
      >('dispatch.provider', facts => handoff(providerPipeline, {
        'route.candidate': facts['route.candidate'],
        payload: facts.payload,
      })));

    const liveChunks: Uint8Array[] = [];
    const barrierOrder: string[] = [];
    let artifactText = '';

    const pump = createDumpPump({
      onLiveChunk: (_offset, bytes) => {
        liveChunks.push(bytes.slice());
      },
      onLiveEnd: () => {
        barrierOrder.push('liveEnd');
      },
      writeArtifact: async stream => {
        const reader = stream.getReader();
        const parts: string[] = [];
        const streamDecoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(streamDecoder.decode(value, { stream: true }));
        }
        parts.push(streamDecoder.decode());
        artifactText = parts.join('');
        barrierOrder.push('artifactCommitted');
      },
      commitMetadata: async () => {
        barrierOrder.push('metadataCommitted');
      },
      onReady: () => {
        barrierOrder.push('ready');
      },
    });

    const out = await runPipeline(servePipeline, {
      'request.http': {
        method: 'POST',
        url: 'https://gateway.local/v1/messages',
        headers: [['content-type', 'application/json']],
        body: { model: 'claude', messages: [{ role: 'user', content: 'Hi' }] },
        protocol: 'anthropic-messages',
      },
      'request.chat': {
        model: 'claude',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    }, { traceSink: pump });

    const clientReceived: string[] = [];
    for await (const chunk of out.body) {
      clientReceived.push(decoderUtf8.decode(chunk));
    }
    expect(clientReceived).toHaveLength(2);
    expect(clientReceived.join('')).toContain('Floway');

    const summary = await pump.completion;
    expect(summary.ok).toBe(true);
    expect(barrierOrder).toEqual(['artifactCommitted', 'metadataCommitted', 'liveEnd', 'ready']);
    expect(artifactText).not.toContain('sk-live-super-secret-upstream-token');

    // Feed live chunks incrementally into browser-compatible decoder
    const dumpDecoder = createDumpDecoder();
    for (const chunk of liveChunks) {
      dumpDecoder.pushNdjsonChunk(chunk);
    }
    const model = dumpDecoder.pushNdjsonChunk(new Uint8Array(0), { final: true });

    // Check stage parent-child tree & downward diff
    const failoverStage = [...model.stages.values()].find(s => s.name === 'route.failover')!;
    expect(failoverStage.childStageIds.length).toBe(3); // 1 subrun + 2 failover attempts!
    const diffs = computeStageDiffs(model, dumpDecoder, failoverStage.stageId);
    expect(diffs.downward.some(d => d.entries.some(e => e.path[0] === 'route.candidate'))).toBe(true);

    // Check 4-face wire projection
    const wire = projectWireView(model);
    expect(wire.downstreamRequest?.url).toBe('https://gateway.local/v1/messages');
    expect(wire.upstreamAttempts).toHaveLength(3);
    expect(wire.upstreamAttempts[0]?.isSubRun).toBe(true);
    expect(wire.upstreamAttempts[1]?.winning).toBe(false);
    expect(wire.upstreamAttempts[1]?.response?.status).toBe(503);
    expect(wire.upstreamAttempts[2]?.winning).toBe(true);
    expect(wire.upstreamAttempts[2]?.response?.status).toBe(200);
    expect(wire.upstreamAttempts[2]?.response?.protocolFrames.map(f => f.value)).toEqual([
      { delta: 'Hello ' },
      { delta: 'Floway' },
    ]);
    expect(wire.downstreamResponse?.status).toBe(200);
    expect(wire.downstreamResponse?.protocolFrames.map(f => f.value)).toEqual([
      { delta: 'Hello ' },
      { delta: 'Floway' },
    ]);

    // Check stream lineage (#2 http.body -> #3 protocol.events -> #4 sse.bytes)
    const winRawId = wire.upstreamAttempts[2]!.response!.rawStreamId!;
    const lineage = getStreamLineage(model, winRawId);
    expect(lineage).toHaveLength(3);

    // Check curl formatting keeps beta=true while masking secret api_key and authorization
    const curl = formatCurlCommand(wire.upstreamAttempts[2]!.request!);
    expect(curl).toContain('beta=true');
    expect(curl).toContain('api_key=***REDACTED***');
    expect(curl).toContain('authorization: ***REDACTED***');
    expect(curl).not.toContain('sk-live-super-secret-upstream-token');
  });
});
