import { describe, expect, it } from 'vitest';

import { attemptPipeline, makeProvider, servePipeline } from './fixtures.ts';
import { encodeRun, isSecret, move, run, secret, storedSecret, streamFact, toNdjson } from '../src/index.ts';
import type { DumpEvent, Event, Stored } from '../src/index.ts';

const NO_SERVICES = {};

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
    const { events } = await run(serve, move({ 'in.text': 'a b c' }), NO_SERVICES);
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
    expect(stored.redacted).toBe('eyJhbGci****qJp-QV30');
    expect(stored.length).toBe(50);
    expect(stored.hash).toMatch(/^0x[0-9a-f]{16}$/);
    const written = JSON.stringify(encodeFacts(move({ auth: token })));
    expect(written).not.toContain('super-secret-payload');
    expect(written).toContain('"$secret"');
  });

  it('gives the same secret the same hash at two events, so a diff reports no change', () => {
    const token = secret('a-token-that-is-quite-long-indeed');
    expect(storedSecret(token).hash).toBe(storedSecret(token).hash);
    expect(storedSecret(secret('another-token-entirely-different')).hash).not.toBe(storedSecret(token).hash);
  });

  it('masks a short secret entirely rather than showing most of it', () => {
    expect(storedSecret(secret('short')).redacted).toBe('*****');
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
    const { events } = await run(serve, move({ 'in.text': 'a b' }), NO_SERVICES);
    const encoded = encodeRun(events);
    const entries = encoded.filter(e => e.type === 'stage.entered');
    const rawEntries = events.filter(e => e.type === 'stage.entered');
    expect(entries).toHaveLength(rawEntries.length);
    expect(entries.some(e => e.facts === undefined)).toBe(true);
    expect(encoded.filter(e => e.type === 'stage.leaved').length)
      .toBeLessThan(events.filter(e => e.type === 'stage.leaved').length);
  });

  it('carries a log line with its structured fields', () => {
    const events: Event[] = [{ type: 'stage.log', stageId: 4, level: 'warn', message: 'slow', fields: { ms: 1200 } }];
    const [encoded] = encodeRun(events).filter(e => e.type === 'stage.log');
    expect(encoded).toMatchObject({ stageId: 4, level: 'warn', message: 'slow' });
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
    const { events } = await run(serve, move({ 'in.text': words }), NO_SERVICES);
    const independent = events.reduce((n, e) => n + ('facts' in e ? JSON.stringify(e.facts).length : 0), 0);
    const deduplicated = toNdjson(encodeRun(events)).length;
    expect(deduplicated).toBeLessThan(independent / 2);
  });
});
