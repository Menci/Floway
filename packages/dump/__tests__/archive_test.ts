import { expect, test } from 'vitest';

import { decodeDump, DeferredReference, diffRequestFacts, RawNumber, SecretDescription, StreamReference, type DumpFacts } from '../src/browser.ts';
import { createDumpEncoder } from '../src/encoder.ts';
import { Secret, type RunEvent } from '@floway-dev/pipeline';

const archiveBody = (text: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
};

test('preserves exact values and object identity across four run-local ID namespaces', async () => {
  const stream = {};
  const deferred = {};
  const idOf = (value: unknown) => value === stream ? { streamId: 1 } : value === deferred ? { deferredId: 1 } : undefined;
  const secret = Secret.from('private key');
  const bytes = new Uint8Array([0, 17, 255]);
  const raw = (JSON as JSON & { rawJSON(value: string): object }).rawJSON('9007199254740993');
  const nested = { ['__proto__']: '🪶', $stream: 20, $$deferred: 38, explicit: undefined, bytes, raw, secret, self: {} };
  nested.self = nested;
  const error = new Error('panic', { cause: Object.assign(new TypeError('invalid'), { nested }) });
  const item = { ok: false, error: nested } as const;
  const answer = { stream, deferred, item, nested };
  const eventSequence: RunEvent[] = [
    { type: 'stage.entered', stageId: 1, name: 'same name', facts: { nested, values: [NaN, Infinity, -Infinity, -0] } },
    { type: 'stage.entered', stageId: 2, parentStageId: 1, name: 'same name', facts: { nested } },
    { type: 'stage.leaved', stageId: 2, error: undefined },
    { type: 'stream.frame', streamId: 1, item },
    { type: 'stream.end', streamId: 1, error },
    { type: 'stream.end', streamId: 2 },
    { type: 'deferred.settled', deferredId: 1, value: nested },
    { type: 'deferred.settled', deferredId: 2, error: undefined },
    { type: 'stage.leaved', stageId: 1, facts: answer },
  ];
  const encoder = createDumpEncoder();
  const text = eventSequence.map(event => new TextDecoder().decode(encoder.encode(event, idOf))).join('');
  const lines = text.trimEnd().split('\n').map(line => JSON.parse(line) as unknown);
  expect(lines.slice(0, 2)).toEqual([
    {
      type: 'object', fromObjectId: 1, nodes: [
        { nested: { $: 2 }, values: { $: 3 } },
        { ['__proto__']: '🪶', $$stream: 20, $$$deferred: 38, explicit: { $undefined: true }, bytes: { $: 4 }, raw: { $: 5 }, secret: { $: 6 }, self: { $: 2 } },
        [{ $number: 'NaN' }, { $number: 'Infinity' }, { $number: '-Infinity' }, { $number: '-0' }],
        { $bytes: 'ABH/' },
        Number('9007199254740993'),
        { $secret: secret.describe() },
      ],
    },
    { type: 'stage.entered', stageId: 1, name: 'same name', facts: { $: 1 } },
  ]);
  expect(text).toContain(',9007199254740993,');
  expect(text).not.toContain('private key');
  expect(lines).toContainEqual({ type: 'stage.leaved', stageId: 2, error: { $undefined: true } });
  expect(lines.at(-2)).toEqual({ type: 'object', fromObjectId: 11, nodes: [{ stream: { $stream: 1 }, deferred: { $deferred: 1 }, item: { $: 8 }, nested: { $: 2 } }] });

  const archive = await decodeDump(archiveBody(text));
  const root = archive.stages.get(archive.rootStageId)!;
  const decoded = root.entry.facts.nested as DumpFacts;
  expect(Object.hasOwn(decoded, '__proto__')).toBe(true);
  expect(decoded.self).toBe(decoded);
  expect(decoded.$stream).toBe(20);
  expect(decoded.$$deferred).toBe(38);
  expect(decoded.bytes).toEqual(bytes);
  expect(decoded.raw).toEqual(new RawNumber('9007199254740993'));
  expect(decoded.secret).toBeInstanceOf(SecretDescription);
  expect(root.entry.facts.values).toEqual([NaN, Infinity, -Infinity, -0]);
  expect(archive.stages.get(2)!.entry.facts.nested).toBe(decoded);
  expect(archive.stages.get(2)!.outcome).toStrictEqual({ error: undefined });
  expect(archive.deferreds.get(1)!.outcome).toEqual({ value: decoded });
  expect(archive.deferreds.get(2)!.outcome).toStrictEqual({ error: undefined });
  expect(archive.streams.get(2)!.outcome).toEqual({});
  const streamOutcome = archive.streams.get(1)!.outcome;
  expect(streamOutcome).toMatchObject({ error: { name: 'Error', message: 'panic', stack: error.stack, cause: { name: 'TypeError', message: 'invalid' } } });
  expect(((streamOutcome.error as DumpFacts).cause as DumpFacts).nested).toBe(decoded);
  expect(root.outcome).toMatchObject({ facts: { deferred: new DeferredReference(1), stream: new StreamReference(1) } });
  expect((root.outcome as { facts: DumpFacts }).facts.item).toBe(archive.streams.get(1)!.frames[0]);
});

test('rejects object references into a later batch and archives without a root outcome', async () => {
  await expect(decodeDump(archiveBody('{"type":"object","fromObjectId":1,"nodes":[{"later":{"$":2}}]}\n')))
    .rejects.toMatchObject({ cause: { message: 'Unknown dump object 2' } });
  await expect(decodeDump(archiveBody('{"type":"object","fromObjectId":1,"nodes":[{}]}\n{"type":"stage.entered","stageId":1,"name":"root","facts":{"$":1}}\n')))
    .rejects.toThrow('Missing dump stage outcome 1');
});

test('diffs parent and child entry snapshots deeply, distinguishing absent keys and preserving repeated paths', () => {
  const before = { value: { $number: -0 }, removed: undefined, array: [1, 2], bytes: new Uint8Array([9]), self: {} };
  const after = { value: { $number: 0 }, added: undefined, array: [1, 5, 6], bytes: new Uint8Array([9]), self: {} };
  before.self = before;
  after.self = after;
  const difference = [
    { path: ['value', '$number'], before: -0, after: 0 },
    { path: ['removed'], before: undefined },
    { path: ['array', 1], before: 2, after: 5 },
    { path: ['array', 2], after: 6 },
    { path: ['added'], after: undefined },
  ];
  expect(diffRequestFacts({ left: before, right: before }, { left: after, right: after })).toStrictEqual(
    ['left', 'right'].flatMap(key => difference.map(change => ({ ...change, path: [key, ...change.path] }))),
  );
});
