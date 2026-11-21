import { describe, expect, it, vi } from 'vitest';

import { createDumpDecoder } from '../src/dump-decoder.ts';
import { createDumpPump } from '../src/dump-pump.ts';
import type { EncodedDumpEvent, RawRunEvent } from '../src/types.ts';

const run = (tMs = 0): RawRunEvent => ({
  k: 'run',
  seq: 1,
  tMs,
  runId: 'run-1',
  pipelineName: 'pipeline-1',
  startedAt: 1_000,
  meta: { requestId: 'request-1' },
});

const enter = (seq = 2): Extract<RawRunEvent, { readonly k: 'enter' }> => ({
  k: 'enter',
  seq,
  tMs: 10 + seq,
  stageId: 1,
  parentStageId: null,
  edgeKind: 'root',
  name: 'root',
  facts: { value: seq },
});

const frame = (seq: number): Extract<RawRunEvent, { readonly k: 'frame' }> => ({
  k: 'frame',
  seq,
  tMs: 20 + seq,
  streamId: 7,
  value: { delta: `frame-${seq}` },
});

const done = (tMs = 100): RawRunEvent => ({
  k: 'done',
  seq: 99,
  tMs,
  ok: true,
  summary: { requests: 1 },
});

const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
};

describe('dump pump', () => {
  it('pushes structural events synchronously without encoding them', () => {
    const encoderOptions = { detectRawSecretLeaks: false } as const;
    const waitUntil = vi.fn();
    const pump = createDumpPump({ encoderOptions, waitUntil });
    const facts = { nested: { large: 'x'.repeat(20_000) } };
    const startedAt = performance.now();
    pump.push({ ...enter(), facts });
    const elapsed = performance.now() - startedAt;
    expect(elapsed).toBeLessThan(10);
    expect(waitUntil).toHaveBeenCalledOnce();
    pump.push(run(1));
    pump.push(done());
    return pump.completion.then(summary => {
      expect(summary.totalBytes).toBeGreaterThan(0);
    });
  });

  it('respects the producer lease and completion barrier ordering', async () => {
    const order: string[] = [];
    let releaseArtifact!: () => void;
    const artifactDone = new Promise<void>(resolve => {
      releaseArtifact = resolve;
    });
    let artifactText = '';
    const pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      async writeArtifact(stream) {
        order.push('writeArtifact-start');
        artifactText = await readStream(stream);
        await artifactDone;
        order.push('writeArtifact-resolved');
      },
      async commitMetadata(summary) {
        order.push('commitMetadata-resolved');
        expect(summary.runId).toBe('run-1');
      },
      onLiveChunk() {
        if (order.length === 0) order.push('live-chunk');
      },
      onLiveEnd(totalBytes) {
        order.push(`onLiveEnd:${totalBytes}`);
      },
      onReady(summary) {
        expect(summary.totalBytes).toBe(new TextEncoder().encode(artifactText).byteLength);
        order.push('onReady');
      },
    });
    const release = pump.acquireProducerLease();
    pump.push(run());
    pump.push(enter());
    pump.push(done());
    let completed = false;
    void pump.completion.then(() => {
      completed = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(completed).toBe(false);
    expect(order).not.toContain('commitMetadata-resolved');
    release();
    release();
    await vi.waitFor(() => {
      expect(order).toContain('writeArtifact-start');
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).not.toContain('commitMetadata-resolved');
    releaseArtifact();
    const summary = await pump.completion;
    expect(summary).toMatchObject({ runId: 'run-1', pipelineName: 'pipeline-1', ok: true, truncated: false, droppedEvents: 0 });
    expect(order.indexOf('writeArtifact-resolved')).toBeLessThan(order.indexOf('commitMetadata-resolved'));
    expect(order.indexOf('commitMetadata-resolved')).toBeLessThan(order.findIndex(value => value.startsWith('onLiveEnd')));
    expect(order.at(-1)).toBe('onReady');
  });

  it('reports live chunks with byte-accurate offsets', async () => {
    const chunks: Array<{ offset: number; text: string; byteLength: number }> = [];
    const pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      onLiveChunk(offset, bytes) {
        chunks.push({ offset, text: new TextDecoder().decode(bytes), byteLength: bytes.byteLength });
      },
    });
    pump.push(run());
    pump.push(enter());
    pump.push(done());
    const summary = await pump.completion;
    let expectedOffset = 0;
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(expectedOffset);
      expectedOffset += chunk.byteLength;
    }
    expect(expectedOffset).toBe(summary.totalBytes);
    expect(chunks.map(chunk => chunk.text).join('')).toContain('"k":"done"');
  });

  it('opens the live failure circuit while the artifact remains complete', async () => {
    const live = vi.fn(() => {
      throw new Error('live consumer failed');
    });
    let artifact = '';
    const pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      maxLiveFailures: 2,
      onLiveChunk: live,
      async writeArtifact(stream) {
        artifact = await readStream(stream);
      },
    });
    pump.push(run());
    pump.push(enter());
    pump.push(done());
    await pump.completion;
    expect(live).toHaveBeenCalledTimes(2);
    const lines = artifact.trim().split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.every(line => {
      JSON.parse(line) as EncodedDumpEvent;
      return true;
    })).toBe(true);
    expect(lines.at(-1)).toContain('"k":"done"');
  });

  it('drops non-critical events under pressure and emits a truncation marker', async () => {
    const events: EncodedDumpEvent[] = [];
    let artifact = '';
    const pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      batchSize: 1,
      maxQueuedEvents: 2,
      async writeArtifact(stream) {
        artifact = await readStream(stream);
      },
    });
    pump.push(run());
    for (let seq = 2; seq < 20; seq++) pump.push(frame(seq));
    pump.push(enter(30));
    pump.push(done());
    const summary = await pump.completion;
    for (const line of artifact.trim().split('\n')) events.push(JSON.parse(line) as EncodedDumpEvent);
    expect(events.some(event => event.k === 'truncated')).toBe(true);
    expect(events.some(event => event.k === 'enter')).toBe(true);
    expect(events.some(event => event.k === 'done')).toBe(true);
    expect(summary.truncated).toBe(true);
    expect(summary.droppedEvents).toBeGreaterThan(0);
    const decoder = createDumpDecoder();
    expect(decoder.pushEvents(events).run?.truncated).toMatchObject({ reason: 'queue-overflow' });
  });

  it('registers completion with waitUntil at creation', () => {
    const waitUntil = vi.fn();
    const pump = createDumpPump({ waitUntil, encoderOptions: { detectRawSecretLeaks: false } });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    pump.push(run());
    pump.push(done());
    return pump.completion.then(summary => {
      expect(summary.totalBytes).toBeGreaterThan(0);
    });
  });

  it('rejects completion immediately when the artifact consumer fails', async () => {
    const artifactError = new Error('artifact failed');
    const pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      writeArtifact: async () => { throw artifactError; },
    });
    pump.push(run());
    pump.push(enter());
    pump.push(done());
    await expect(pump.completion).rejects.toBe(artifactError);
  });

  it('rejects completion when final metadata work throws', async () => {
    const commitError = new Error('metadata failed');
    const artifact = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      async writeArtifact(stream) { await readStream(stream); },
      commitMetadata: async () => { throw commitError; },
    });
    artifact.push(run());
    artifact.push(enter());
    artifact.push(done());
    await expect(artifact.completion).rejects.toBe(commitError);

    const readyError = new Error('ready failed');
    const ready = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      onReady: () => { throw readyError; },
    });
    ready.push(run());
    ready.push(done());
    await expect(ready.completion).rejects.toBe(readyError);
  });

  it('applies artifact backpressure before dropping queued bytes', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let artifact = '';
    const large = { payload: 'x'.repeat(2_048) };
    const pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      batchSize: 1,
      maxQueuedEvents: 10_000,
      maxQueuedBytes: 4_096,
      async writeArtifact(stream) {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        const first = await reader.read();
        if (!first.done) artifact += decoder.decode(first.value, { stream: true });
        await held;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          artifact += decoder.decode(next.value, { stream: true });
        }
        artifact += decoder.decode();
      },
    });
    pump.push(run());
    pump.push(enter());
    for (let seq = 3; seq < 20; seq++) {
      pump.push({ k: 'log', seq, tMs: seq, stageId: 1, level: 'info', message: `large-${seq}`, fields: large });
    }
    pump.push(done());
    await vi.waitFor(() => {
      expect(artifact.length).toBeGreaterThan(0);
    });
    release();
    const summary = await pump.completion;
    expect(summary.truncated).toBe(true);
    expect(summary.droppedEvents).toBeGreaterThan(0);
    expect(artifact).toContain('"k":"truncated"');
  });

  it('accounts for cyclic and bigint-bearing frame values without JSON serialization', async () => {
    const cyclic: { self?: unknown; value: bigint } = { value: 1n };
    cyclic.self = cyclic;
    let artifact = '';
    const pump = createDumpPump({
      encoderOptions: { detectRawSecretLeaks: false },
      maxQueuedBytes: 512,
      async writeArtifact(stream) { artifact = await readStream(stream); },
    });
    pump.push(run());
    pump.push({ ...frame(2), value: cyclic });
    pump.push(done());
    const summary = await pump.completion;
    expect(summary.totalBytes).toBeGreaterThan(0);
    expect(artifact).toContain('"k":"frames"');
  });
});
