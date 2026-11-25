import { expect, test } from 'vitest';

import { createDumpDecoder, decodeDump, isDumpDeferredRef, isDumpRawJson, isDumpSecret, isDumpStreamRef } from '../src/browser.ts';
import { createDumpEncoder } from '../src/index.ts';
import { factSpace, move, run, Secret } from '@floway-dev/pipeline';
import type { Deferred, ManagedStream, RunEvent } from '@floway-dev/pipeline';

const archive = (...events: RunEvent[]): string => {
  const encoder = createDumpEncoder();
  const decoder = new TextDecoder();
  return events.map(event => decoder.decode(encoder.encode(event))).join('');
};

test('shares object identities across facts, including cycles, bytes, secrets and exact raw JSON', () => {
  const json = JSON as JSON & { rawJSON(value: string): object };
  const secret = Secret.from('secret credential value');
  const bytes = Uint8Array.of(0, 0x7f, 0x80, 0xff);
  const raw = json.rawJSON('900719925474099312345');
  const shared: Record<string, unknown> = {
    $: '美元', $$: 2, $stream: 3, ['__proto__']: 'value', bytes, secret, raw,
    undefined, negativeZero: -0, nan: NaN, infinity: Infinity, negativeInfinity: -Infinity,
  };
  shared.self = shared;
  const list = [shared];
  const output = archive(
    { type: 'stage.entered', stageId: 1, name: 'parent', facts: { shared, list } },
    { type: 'stage.entered', stageId: 2, name: 'child', parentStageId: 1, facts: { shared } },
    { type: 'stage.leaved', stageId: 2, facts: { list, secret } },
    { type: 'stage.leaved', stageId: 1, facts: { raw } },
  );
  expect(output).toContain('"$$":"美元","$$$":2,"$$stream":3');
  expect(output).toContain('900719925474099312345');
  expect(output).toContain('"$bytes":"AH+A/w=="');
  expect(output).toContain('"$undefined":true');
  expect(output).not.toContain('secret credential value');
  expect(output.match(/"\$secret"/g)).toHaveLength(1);
  const decoder = createDumpDecoder();
  const encoded = new TextEncoder().encode(output);
  for (let offset = 0; offset < encoded.length; offset += 3) decoder.push(encoded.subarray(offset, offset + 3));
  const dump = decoder.finish();
  const parent = dump.stages.get(1)!;
  const child = dump.stages.get(2)!;
  expect(dump.rootStageIds).toEqual([1]);
  expect(parent.childStageIds).toEqual([2]);
  const recorded = parent.requestFacts.shared as Record<string, unknown>;
  expect(recorded).toBe(child.requestFacts.shared);
  expect(recorded.self).toBe(recorded);
  expect(parent.requestFacts.list).toBe(child.responseFacts?.list);
  expect((parent.requestFacts.list as unknown[])[0]).toBe(recorded);
  expect(recorded).toMatchObject({ $: '美元', $$: 2, $stream: 3, bytes, negativeZero: -0, nan: NaN, infinity: Infinity, negativeInfinity: -Infinity });
  expect(Object.hasOwn(recorded, '__proto__') && recorded.__proto__).toBe('value');
  expect(Object.hasOwn(recorded, 'undefined')).toBe(true);
  expect(recorded.undefined).toBeUndefined();
  expect(recorded.secret).toBe(child.responseFacts?.secret);
  expect(isDumpSecret(recorded.secret) && recorded.secret.$secret).toEqual(secret.describe());
  expect(recorded.raw).toBe(parent.responseFacts?.raw);
  expect(isDumpRawJson(recorded.raw) && recorded.raw.rawJSON).toBe('900719925474099312345');
});

test('retains the original throw-site facts and shared panic error with available fields', () => {
  const cause = new TypeError('bad upstream data');
  const error = new AggregateError([cause], 'bad response', { cause });
  const dump = decodeDump(archive(
    { type: 'stage.entered', stageId: 1, name: 'forward', facts: {} },
    { type: 'stage.entered', stageId: 2, name: 'throw', parentStageId: 1, facts: {} },
    { type: 'stage.panicked', stageId: 2, error, facts: { received: new Uint8Array([0xff]) } },
    { type: 'stage.panicked', stageId: 1, error },
  ));
  const parent = dump.stages.get(1)!;
  const child = dump.stages.get(2)!;
  expect(parent.panic?.error).toBe(child.panic?.error);
  expect(parent.panic).not.toHaveProperty('facts');
  expect(child.panic?.facts?.received).toEqual(Uint8Array.of(0xff));
  const decoded = child.panic?.error as { cause: unknown; errors: unknown[] };
  expect(decoded).toMatchObject({ name: 'AggregateError', message: error.message, stack: error.stack, cause: { name: 'TypeError', message: cause.message, stack: cause.stack } });
  expect(decoded.errors[0]).toBe(decoded.cause);
});

test('uses separate namespaces for stages, objects, streams and deferreds in one run', async () => {
  const encoder = createDumpEncoder();
  const decoder = createDumpDecoder();
  const payload = move({ value: 'frame' });
  const { compose, defineStage } = factSpace<{
    stream: ManagedStream<typeof payload, string>;
    deferred: Deferred<typeof payload>;
  }>();
  const ending = defineStage({
    name: 'emit',
    request: { needs: [] },
    return: { provides: ['stream', 'deferred'] },
    execute: async (_facts, scope) => {
      const { deferred, resolve } = scope.deferred<typeof payload>();
      resolve(payload);
      const stream = scope.createStream<typeof payload, string>(async function* () {
        yield { ok: true, value: payload };
        yield { ok: false, error: 'failed frame' };
      });
      return { stream, deferred };
    },
  });
  const pipeline = compose('event-test', { entry: [], exit: ['stream', 'deferred'], stages: [], ending });
  const handle = run(pipeline, {}, { services: {}, events: event => { decoder.push(encoder.encode(event)); } });
  const answer = await handle.result;
  for await (const _frame of answer.stream) { /* Drain the stream through its end event. */ }
  await handle.done;
  const model = decoder.finish();
  const facts = model.stages.get(1)?.responseFacts;
  expect(isDumpStreamRef(facts?.stream) && facts.stream.$stream).toBe(1);
  expect(isDumpDeferredRef(facts?.deferred) && facts.deferred.$deferred).toBe(1);
  const stream = model.streams.get(1)!;
  const settlement = model.deferreds.get(1)?.settlement;
  expect(stream.ended).toBe(true);
  expect(stream.frames).toEqual([{ ok: true, value: payload }, { ok: false, error: 'failed frame' }]);
  expect(settlement?.ok && settlement.value).toBe(stream.frames[0]?.ok && stream.frames[0]?.value);
});

test('rejects BigInt instead of continuing with a partial object space', () => {
  const encoder = createDumpEncoder();
  expect(() => encoder.encode({ type: 'stage.entered', stageId: 1, name: 'bigint', facts: { value: 1n } })).toThrow('Unsupported dump value bigint');
  expect(() => encoder.encode({ type: 'stage.leaved', stageId: 1, facts: {} })).toThrow('Unsupported dump value bigint');
});
