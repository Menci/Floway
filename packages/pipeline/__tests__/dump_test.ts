import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { attemptPipeline, makeProvider, servePipeline } from './fixtures.ts';
import { compose, createRunEncoder, defer, defineStage, encodeRun, isSecret, move, run, secret, storedSecret, streamFact, toNdjson } from '../src/index.ts';
import type { DumpEvent, Event, Stored } from '../src/index.ts';

const recording = () => {
  const events: Event[] = [];
  return { events, services: { dump: (event: Event) => { events.push(event); } } };
};

const refsIn = (value: Stored, out: number[] = []): number[] => {
  if (typeof value !== 'object' || value === null) return out;
  if (Array.isArray(value)) { for (const item of value) refsIn(item, out); return out; }
  const record = value as Record<string, Stored>;
  if ('$' in record && typeof record['$'] === 'number') { out.push(record['$']); return out; }
  for (const child of Object.values(record)) refsIn(child, out);
  return out;
};

const encodeFacts = (facts: object): DumpEvent[] =>
  encodeRun([{ type: 'stage.entered', stageId: 1, name: 'only', parentStageId: null, facts: facts as never }]);

describe('the dump encoding', () => {
  it('gives every object an id at first sight and refers to it thereafter', () => {
    const shared = move({ n: 1 });
    const events = encodeFacts(move({ a: shared, b: shared }));
    const entered = events.find(e => e.type === 'stage.entered')!;
    const facts = entered.facts as Record<string, Stored>;
    expect(facts['a']).toEqual(facts['b']);
    // One node, reached twice. The facts map itself is not a node — its keys are the
    // event's own shape, and two events that share a whole record share it by folding.
    const nodes = events.filter(e => e.type === 'object').flatMap(e => e.nodes);
    expect(nodes).toEqual([{ n: 1 }]);
  });

  // An id is taken before recursing, which is what makes a cycle terminate on its second
  // visit rather than recursing forever.
  it('terminates on a cycle', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a['b'] = b;
    const events = encodeFacts(move({ root: a }));
    const objects = events.filter(e => e.type === 'object');
    expect(objects).toHaveLength(1);
    expect(JSON.stringify(objects[0]!.nodes)).toContain('"$"');
  });

  // The invariant every `object` event owes: no reference points forward into an event
  // that has not arrived. That is what makes the stream emittable as it happens.
  it('never refers forward past the event it is in', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['flaky', 'steady']));
    const { events, services } = recording();
    await run(serve, move({ 'in.text': 'a b c' }), services);
    let highest = 0;
    for (const event of encodeRun(events)) {
      if (event.type === 'object') {
        highest = event.fromObjectId + event.nodes.length - 1;
        for (const node of event.nodes) {
          for (const ref of refsIn(node)) expect(ref).toBeLessThanOrEqual(highest);
        }
        continue;
      }
      const carried = event.type === 'stage.entered' ? event.facts : event.type === 'stage.leaved' ? event.facts : undefined;
      if (carried === undefined) continue;
      for (const value of Object.values(carried)) {
        for (const ref of refsIn(value)) expect(ref).toBeLessThanOrEqual(highest);
      }
    }
  });

  // A tool's parameters are JSON Schema, so `$schema`, `$defs` and `$ref` really do arrive.
  it('escapes a key that already begins with a dollar', () => {
    const events = encodeFacts(move({ tool: { $ref: '#/$defs/q', $defs: { q: 1 } } }));
    const written = JSON.stringify(events);
    expect(written).toContain('"$$ref"');
    expect(written).toContain('"$$defs"');
    // Only keys are escaped: a `$` inside a value is data.
    expect(written).toContain('#/$defs/q');
  });

  it('tags a stream by id rather than holding it', () => {
    // A stream tag is written where it sits: it is an identifier, not an object that
    // needs one, and its content arrives later in `stream.frame` events naming that id.
    const events = encodeFacts(move({ body: streamFact(3) }));
    const entered = events.find(e => e.type === 'stage.entered')!;
    expect((entered.facts as Record<string, Stored>)['body']).toEqual({ $stream: 3 });
    expect(events.some(e => e.type === 'object')).toBe(false);
  });

  it('stores a secret as length, redaction and hash, and never as itself', () => {
    const token = secret('eyJhbGciOiJIUzI1NiJ9.super-secret-payload.qJp-QV30');
    expect(isSecret(token)).toBe(true);
    const stored = storedSecret(token);
    expect(stored.redacted).toBe('*'.repeat(50));
    expect(stored.length).toBe(50);
    expect(stored.hash).toMatch(/^0x[0-9a-f]{16}$/);
    const written = JSON.stringify(encodeFacts(move({ auth: token })));
    expect(written).not.toContain('super-secret-payload');
    expect(written).toContain('"$secret"');
  });

  // Two separately constructed wrappers around the same secret, which is what a diff
  // across two events actually compares.
  it('gives the same secret the same hash at two events, so a diff reports no change', () => {
    const first = secret('a-token-that-is-quite-long-indeed');
    const second = secret('a-token-that-is-quite-long-indeed');
    expect(first).not.toBe(second);
    expect(storedSecret(first).hash).toBe(storedSecret(second).hash);
    expect(storedSecret(secret('another-token-entirely-different')).hash).not.toBe(storedSecret(first).hash);
  });

  it('masks a short secret entirely rather than showing most of it', () => {
    expect(storedSecret(secret('short')).redacted).toBe('*****');
  });

  it('records portable file metadata and bytes exactly', () => {
    const events = encodeFacts(move({ upload: { name: 'voice.wav', type: 'audio/wav', lastModified: 42, bytes: new Uint8Array([65, 66, 67]) } }));
    const nodes = events.filter(event => event.type === 'object').flatMap(event => event.nodes);
    expect(nodes).toContainEqual({ name: 'voice.wav', type: 'audio/wav', lastModified: 42, bytes: { $: 2 } });
    expect(nodes).toContainEqual({ $bytes: 'QUJD' });
    expect(() => encodeFacts(move({ upload: new File(['ABC'], 'voice.wav') }))).toThrow('bytes and metadata');
  });

  it('shares complete byte values across buffer and view identities', () => {
    const original = new Uint8Array([1, 2, 3]);
    const buffer = original.slice().buffer;
    const view = new DataView(buffer);
    const events = encodeFacts(move({ original, buffer, view }));
    expect(events.filter(event => event.type === 'object').flatMap(event => event.nodes)).toEqual([{ $bytes: 'AQID' }]);
    const facts = events.find(event => event.type === 'stage.entered')!.facts!;
    expect(facts['original']).toEqual(facts['buffer']);
    expect(facts['buffer']).toEqual(facts['view']);
  });

  it('preserves collection and date content with explicit tags', () => {
    const key = { id: 3 };
    const events = encodeFacts(move({ map: new Map([[key, 'value']]), set: new Set([key]), date: new Date(1234) }));
    const nodes = events.filter(event => event.type === 'object').flatMap(event => event.nodes);
    expect(nodes).toContainEqual({ $date: 1234 });
    expect(nodes.some(node => typeof node === 'object' && node !== null && '$map' in node)).toBe(true);
    expect(nodes.some(node => typeof node === 'object' && node !== null && '$set' in node)).toBe(true);
    expect(nodes.filter(node => JSON.stringify(node) === '{"id":3}')).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('value');
    expect(Object.isFrozen(key)).toBe(true);
  });

  it('distinguishes a native body from a recorded protocol stream', () => {
    const body = new ReadableStream<Uint8Array>({ start: controller => controller.close() });
    const events = encodeFacts(move({ body, frames: streamFact(7) }));
    expect(events.filter(event => event.type === 'object').flatMap(event => event.nodes)).toContainEqual({ $readableStream: true });
    expect(events.find(event => event.type === 'stage.entered')?.facts?.['frames']).toEqual({ $stream: 7 });
  });

  it('retains non-enumerable error details and shared causes', () => {
    const cause = new TypeError('provider fault');
    const error = new AggregateError([cause], 'failed', { cause });
    const events = encodeFacts(move({ error }));
    const nodes = events.filter(event => event.type === 'object').flatMap(event => event.nodes);
    const stored = nodes[0] as { $error: Record<string, Stored> };
    expect(stored.$error['name']).toBe('AggregateError');
    expect(stored.$error['message']).toBe('failed');
    const stack = stored.$error['stack'];
    const stackValue = typeof stack === 'object' && stack !== null && '$' in stack && typeof stack.$ === 'number' ? nodes[stack.$ - 1] : stack;
    expect(stackValue).toBe(error.stack);
    const errors = nodes[Number((stored.$error['errors'] as { $: number }).$) - 1] as Stored[];
    expect(errors[0]).toEqual(stored.$error['cause']);
  });

  it('records deferred content when the original fact settles', async () => {
    const pending = defer(Promise.resolve({ count: 3 }));
    const seen: Event[] = [];
    const ending = compose('deferredDump', [defineStage<Record<string, never>, { pending: typeof pending }>({
      name: 'ending', return: { provides: ['pending'] }, execute: async facts => move({ ...facts, pending }),
    })]);
    const result = await run(ending, move({}), { dump: event => { seen.push(event); } });
    await result.drain();
    expect(seen.filter(event => event.type === 'deferred.settled')).toHaveLength(1);
    const encoded = encodeRun(seen);
    expect(encoded.filter(event => event.type === 'object').flatMap(event => event.nodes)).toContainEqual({ $deferred: true });
    expect(encoded.find(event => event.type === 'deferred.settled')).toHaveProperty('deferred');
    expect(JSON.stringify(encoded)).toContain('"count":3');
  });

  it('shares a large string by value, which reference sharing cannot reach', () => {
    const image = 'A'.repeat(4096);
    const events = encodeFacts(move({ first: { data: image }, second: { data: image } }));
    const nodes = events.filter(e => e.type === 'object').flatMap(e => e.nodes);
    expect(nodes.filter(node => node === image)).toHaveLength(1);
  });

  // A `stage.entered` always appears — dropping it would strand its children's
  // `parentStageId` — but it carries `facts` only when they differ from its parent's.
  it('folds an entry that carries nothing of its own, and drops an exit that does', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['steady']));
    const { events, services } = recording();
    await run(serve, move({ 'in.text': 'a b' }), services);
    const encoded = encodeRun(events);
    const entries = encoded.filter(e => e.type === 'stage.entered');
    const rawEntries = events.filter(e => e.type === 'stage.entered');
    expect(entries).toHaveLength(rawEntries.length);
    expect(entries.some(e => e.facts === undefined)).toBe(true);
    expect(encoded.filter(e => e.type === 'stage.leaved').length)
      .toBeLessThan(events.filter(e => e.type === 'stage.leaved').length);
  });

  it('carries a log line with its structured fields', () => {
    const events: Event[] = [{ type: 'stage.log', stageId: 4, level: 'warn', context: 'callUpstream', message: 'slow', fields: { ms: 1200 } }];
    const [encoded] = encodeRun(events).filter(e => e.type === 'stage.log');
    expect(encoded).toMatchObject({ stageId: 4, level: 'warn', message: 'slow', fields: { ms: 1200 } });
  });

  // A buffer is atomic and records its full content, the way a string does. Walking it by
  // index would turn one image into a JSON object with a key per byte — an expansion of
  // exactly the value most likely to be large, and enough to break the single-`put` sizing.
  it('records a buffer as bytes rather than as an object keyed by index', () => {
    const events = encodeFacts(move({ 'request.http.body': new Uint8Array([1, 2, 3, 4, 5]) }));
    const nodes = events.filter(e => e.type === 'object').flatMap(e => e.nodes);
    expect(nodes).toEqual([{ $bytes: 'AQIDBAU=' }]);
  });

  it('keeps a large buffer close to its own size instead of multiplying it', () => {
    const image = move({ 'request.http.body': new Uint8Array(400 * 1024) });
    const written = toNdjson(encodeFacts(image)).length;
    expect(written).toBeLessThan(600 * 1024);
  });

  // The design's own reason for refusing `undefined` as a removal is that `JSON.stringify`
  // drops it, so the record and the dump would disagree in the direction that looks
  // correct. Every value JSON cannot carry therefore gets a tag.
  it('carries the values JSON cannot', () => {
    const events = encodeFacts(move({ payload: { missing: undefined, nan: NaN, up: Infinity, down: -Infinity, big: 10n } }));
    const [node] = events.filter(e => e.type === 'object').flatMap(e => e.nodes);
    expect(node).toEqual({
      missing: { $undefined: true },
      nan: { $number: 'NaN' },
      up: { $number: 'Infinity' },
      down: { $number: '-Infinity' },
      big: { $bigint: '10' },
    });
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it('keeps a key whose value is undefined, because the record kept it too', () => {
    const payload = move({ payload: { a: 1, b: undefined } });
    expect('b' in (payload.payload as object)).toBe(true);
    const written = toNdjson(encodeFacts(payload));
    expect(written).toContain('$undefined');
  });

  // One event in, its encoding out — so a run can be written down as it happens rather
  // than only once it is over, which is what a live observer and an appended file need.
  it('encodes one event at a time, with ids carried across calls', () => {
    const shared = move({ n: 1 });
    const encode = createRunEncoder();
    const first = encode({ type: 'stage.entered', stageId: 1, name: 'a', parentStageId: null, facts: move({ x: shared }) as never });
    const second = encode({ type: 'stage.entered', stageId: 2, name: 'b', parentStageId: 1, facts: move({ y: shared }) as never });
    expect(first.filter(e => e.type === 'object')).toHaveLength(1);
    expect(second.filter(e => e.type === 'object')).toHaveLength(0);   // already has an id
    const entered = second.find(e => e.type === 'stage.entered')!;
    expect((entered.facts as Record<string, Stored>)['y']).toEqual({ $: 1 });
  });

  it('writes one event per line', () => {
    const ndjson = toNdjson(encodeFacts(move({ a: { n: 1 } })));
    expect(ndjson.endsWith('\n')).toBe(true);
    const lines = ndjson.trimEnd().split('\n');
    expect(lines).toHaveLength(2);   // the object it first saw, then the entry itself
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  // What makes exact retention affordable: deduplicated storage grows with the
  // conversation plus what each stage changed, not with events times conversation.
  it('costs a fraction of writing every state independently', async () => {
    const serve = servePipeline(attemptPipeline(makeProvider('tok', []), ['flaky', 'steady']));
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const { events, services } = recording();
    await run(serve, move({ 'in.text': words }), services);
    const independent = events.reduce((n, e) => n + ('facts' in e ? JSON.stringify(e.facts).length : 0), 0);
    const deduplicated = toNdjson(encodeRun(events)).length;
    expect(deduplicated).toBeLessThan(independent / 2);
  });
});

it('a live encoder releases original fact graphs when stages return or fail', async () => {
  const child = spawn(process.execPath, ['--expose-gc', '--import', import.meta.resolve('jiti/register'), fileURLToPath(new URL('./fixtures/encoder-retention.ts', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [code] = await once(child, 'exit');
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
});
