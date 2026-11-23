import { expect, it } from 'vitest';

import { closed, done, enter, leave, runEvent } from './fixtures.ts';
import { createDumpDecoder } from '../src/browser.ts';
import { createDumpEncoder } from '../src/encoder.ts';

it('keeps an answered parent open through another turn and ends its duration on a failed close', () => {
  const decoder = createDumpDecoder();
  const encoder = createDumpEncoder();
  const response = { message: '你好' };
  decoder.pushEvents(encoder.encodeBatch([runEvent, enter(2, 1, {})]));
  const root = decoder.model.stages.get(1)!;
  expect(root.status).toBe('running');
  const answer = encoder.encodeBatch([leave(3, 1, response)]).map(event => `${JSON.stringify(event)}\n`).join('');
  const bytes = new TextEncoder().encode(answer);
  for (const byte of bytes) decoder.push(Uint8Array.of(byte));
  expect(root.responseFacts).toEqual(response);
  expect(root.status).toBe('answered');
  expect(root.durationMs).toBeUndefined();

  decoder.pushEvents(encoder.encodeBatch([
    enter(4, 2, {}, 1, 'next'),
    leave(5, 2, {}),
    closed(6, 2),
  ]));
  expect(root.status).toBe('answered');
  expect(root.childStageIds).toEqual([2]);
  expect(decoder.model.stages.get(2)?.status).toBe('succeeded');
  const error = { name: 'Error', message: 'turn-two writer failed' };
  decoder.pushEvents(encoder.encodeBatch([
    { k: 'closed', seq: 7, tMs: 32, stageId: 1, ok: false, error },
    done(8, false),
  ]));
  expect(decoder.finish().run?.done?.ok).toBe(false);
  expect(root).toMatchObject({ status: 'failed', leftAtMs: 3, closedAtMs: 32, durationMs: 30, error });
});

it('records failure facts, logs, and a rejected deferred on the stage that owned them', () => {
  const error = { name: 'Error', message: 'settlement failed' };
  const decoder = createDumpDecoder();
  decoder.pushEvents(createDumpEncoder().encodeBatch([
    runEvent,
    enter(2, 1, { input: 1 }),
    { k: 'log', seq: 3, tMs: 3, stageId: 1, level: 'warn', message: 'missing cost', fields: { input: 1 } },
    { k: 'deferred', seq: 4, tMs: 4, stageId: 1, deferredId: 1, name: 'persistence' },
    { k: 'settled', seq: 5, tMs: 5, deferredId: 1, ok: false, error },
    { k: 'fail', seq: 6, tMs: 6, stageId: 1, error, facts: { input: 1, extra: true } },
  ]));
  const stage = decoder.model.stages.get(1)!;
  expect(stage).toMatchObject({
    status: 'failed',
    failureFacts: { input: 1, extra: true },
    logs: [{ level: 'warn', message: 'missing cost', fields: { input: 1 } }],
    deferredIds: [1],
  });
  expect(stage.durationMs).toBeUndefined();
  const settlement = decoder.model.deferreds.get(1)?.settlement;
  expect(settlement).toMatchObject({ ok: false, error });
  if (!settlement || settlement.ok) throw new Error('Expected the deferred to fail');
  expect(settlement.error).toBe(stage.error);
});
