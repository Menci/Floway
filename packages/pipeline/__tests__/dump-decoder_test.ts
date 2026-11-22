import { describe, expect, it } from 'vitest';

import {
  createDumpDecoder,
  computeStageDiffs,
  diffStoredValues,
  getStreamLineage,
  isDecodedRawJson,
} from '../src/dump-decoder.ts';
import type { EncodedDumpEvent, StoredValue } from '../src/types.ts';

const run: EncodedDumpEvent = {
  k: 'run',
  seq: 1,
  tMs: 100,
  runId: 'run-1',
  pipelineName: 'pipeline-1',
  startedAt: 1_000,
  meta: { title: '测试 🚀' },
};

const stageEvents: EncodedDumpEvent[] = [
  {
    k: 'enter',
    seq: 2,
    tMs: 110,
    stageId: 1,
    parentStageId: null,
    edgeKind: 'root',
    name: 'root',
    tap: 'downstream',
    facts: { prompt: { text: 'same' }, model: 'one' },
  },
  {
    k: 'enter',
    seq: 3,
    tMs: 120,
    stageId: 2,
    parentStageId: 1,
    edgeKind: 'child',
    name: 'upstream',
    tap: 'upstream',
    facts: { prompt: { text: 'same' }, model: 'two' },
  },
  {
    k: 'leave',
    seq: 4,
    tMs: 140,
    stageId: 2,
    outcome: { status: 200, body: { $stream: 8 } },
  },
  {
    k: 'leave',
    seq: 5,
    tMs: 160,
    stageId: 1,
    outcome: { status: 201, body: 'ok' },
  },
  {
    k: 'stream',
    seq: 6,
    tMs: 125,
    streamId: 7,
    createdByStageId: 2,
    label: 'raw-bytes',
  },
  {
    k: 'stream',
    seq: 7,
    tMs: 126,
    streamId: 8,
    createdByStageId: 2,
    wraps: 7,
    label: 'protocol.events',
  },
  {
    k: 'stream',
    seq: 8,
    tMs: 127,
    streamId: 9,
    createdByStageId: 1,
    wraps: 8,
    label: 'sse.bytes',
  },
  {
    k: 'frames',
    streamId: 8,
    frames: [
      { seq: 9, tMs: 130, v: { event: 'one' } },
      { seq: 10, tMs: 137, v: { event: 'two' } },
    ],
  },
  { k: 'end', seq: 11, tMs: 145, streamId: 8, how: 'exhausted' },
];

describe('dump decoder', () => {
  it('streams NDJSON byte-by-byte across multi-byte UTF-8 boundaries', () => {
    const text = [
      run,
      ...stageEvents,
    ].map(event => `${JSON.stringify(event)}\n`).join('');
    const bytes = new TextEncoder().encode(text);
    const streaming = createDumpDecoder();
    let model = streaming.view();
    for (let index = 0; index < bytes.length; index++) model = streaming.pushNdjsonChunk(bytes.subarray(index, index + 1));
    model = streaming.pushNdjsonChunk(new Uint8Array(), { final: true });
    expect(model.run).toMatchObject({ runId: 'run-1', meta: { title: '测试 🚀' } });
    expect(model.stages.get(2)?.status).toBe('succeeded');
    expect(model.streams.get(8)?.frames).toHaveLength(2);
  });

  it('restores cyclic object graphs and tagged values', () => {
    const decoder = createDumpDecoder();
    decoder.pushEvents([
      {
        k: 'obj',
        from: 0,
        nodes: [
          { self: { $: 0 }, values: { $: 1 } },
          [{ $undefined: true }, { $bigint: '42' }, { $bytes: 'AQI=' }, { $error: { name: 'Error' } }],
        ],
      },
    ]);
    const cyclic = decoder.resolve({ $: 0 });
    if (typeof cyclic !== 'object' || cyclic === null || !('self' in cyclic)) throw new Error('expected cyclic object');
    expect(cyclic.self).toBe(cyclic);
    expect(decoder.resolve({ $number: '-0' })).toBe(-0);
    expect(Number.isNaN(decoder.resolve({ $number: 'NaN' }))).toBe(true);
    expect(decoder.resolve({ $bigint: '42' })).toBe(42n);
    expect(decoder.resolve({ $bytes: 'AQI=' })).toEqual(new Uint8Array([1, 2]));
  });

  it('prunes unchanged references and nested shared subtrees in structural diffs', () => {
    const decoder = createDumpDecoder();
    decoder.pushEvents([{
      k: 'obj',
      from: 0,
      nodes: [
        { shared: { $: 2 }, left: 'before' },
        { shared: { $: 2 }, left: 'after', added: true },
        { value: 'unchanged' },
      ],
    }]);
    expect(diffStoredValues({ $: 0 }, { $: 0 }, decoder)).toEqual([]);
    expect(diffStoredValues({ $: 0 }, { $: 1 }, decoder)).toEqual([
      { path: ['left'], kind: 'changed', before: 'before', after: 'after' },
      { path: ['added'], kind: 'added', after: true },
    ]);
  });

  it('prunes equal secret hashes by identity', () => {
    const decoder = createDumpDecoder();
    const before: StoredValue = { $secret: { length: 3, hash: 'same', redacted: '***' } };
    const after: StoredValue = { $secret: { length: 3, hash: 'same', redacted: '***' } };
    expect(diffStoredValues(before, after, decoder)).toEqual([]);
  });

  it('produces exact downward and upward child-stage diffs', () => {
    const decoder = createDumpDecoder();
    const model = decoder.pushEvents([run, ...stageEvents]);
    const diffs = computeStageDiffs(model, decoder, 1);
    expect(diffs.downward).toEqual([{
      childStageId: 2,
      childName: 'upstream',
      entries: [{ path: ['model'], kind: 'changed', before: 'one', after: 'two' }],
    }]);
    expect(diffs.upward).toEqual([{
      childStageId: 2,
      childName: 'upstream',
      entries: [{
        path: ['status'],
        kind: 'changed',
        before: 200,
        after: 201,
      }, {
        path: ['body'],
        kind: 'changed',
        before: { $stream: 8 },
        after: 'ok',
      }],
    }]);
  });

  it('tracks stream wrapping lineage and derived streams', () => {
    const decoder = createDumpDecoder();
    const model = decoder.pushEvents([run, ...stageEvents]);
    expect(getStreamLineage(model, 8)).toEqual([7, 8, 9]);
    expect(getStreamLineage(model, 9)).toEqual([7, 8, 9]);
    expect(model.streams.get(8)?.frames.map(frame => frame.deltaMs)).toEqual([0, 7]);
    expect(model.streams.get(8)?.end).toMatchObject({ how: 'exhausted' });
  });

  it('preserves truncation and completion on the run model', () => {
    const decoder = createDumpDecoder();
    const model = decoder.pushEvents([
      run,
      { k: 'truncated', seq: 2, tMs: 120, reason: 'queue-overflow', droppedEvents: 4 },
      { k: 'done', seq: 3, tMs: 150, ok: false, error: { message: 'failed' } },
    ]);
    expect(model.run).toMatchObject({
      truncated: { tMs: 120, reason: 'queue-overflow', droppedEvents: 4 },
      done: { tMs: 150, ok: false, error: { message: 'failed' } },
    });
  });

  it('restores escaped tag-like keys on inline objects and errors', () => {
    const decoder = createDumpDecoder();
    const model = decoder.pushEvents([
      run,
      {
        k: 'done',
        seq: 20,
        tMs: 150,
        ok: false,
        error: {
          $error: {
            name: 'Error',
            message: 'failed',
            $$metadata: 'error metadata',
          },
        },
      },
      {
        k: 'enter',
        seq: 3,
        tMs: 160,
        stageId: 1,
        parentStageId: null,
        edgeKind: 'root',
        name: 'escaped',
        facts: { $$metadata: 'inline metadata' },
      },
    ]);
    expect((model.run?.done?.error as { $error?: { $metadata?: string } }).$error?.$metadata).toBe('error metadata');
    expect((model.stages.get(1)?.facts as { $metadata?: string }).$metadata).toBe('inline metadata');
  });

  it('brands the raw JSON fallback when the runtime lacks JSON.rawJSON', () => {
    const descriptors = ['rawJSON', 'isRawJSON'].map(key => [
      key,
      Object.getOwnPropertyDescriptor(JSON, key),
    ] as const);
    for (const [key] of descriptors) Object.defineProperty(JSON, key, { configurable: true, value: undefined });
    try {
      const raw = createDumpDecoder().resolve({ $rawJson: '9007199254740993' });
      expect(isDecodedRawJson(raw)).toBe(true);
      expect((raw as { readonly rawJSON: string }).rawJSON).toBe('9007199254740993');
      expect(isDecodedRawJson({ rawJSON: '9007199254740993' })).toBe(false);
    } finally {
      for (const [key, descriptor] of descriptors) {
        if (descriptor !== undefined) Object.defineProperty(JSON, key, descriptor);
      }
    }
  });
});
