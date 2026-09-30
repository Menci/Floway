import { expect, test } from 'vitest';

import { clientStreamOf } from '../../../src/components/requests/run-stream';
import { encodeRun, streamFact, toNdjson } from '@floway-dev/pipeline';

for (const collected of [true, false]) {
  for (const ended of [true, false]) {
    test(`selects client frames and their own completion (${collected ? 'collected' : 'streamed'}, ${ended ? 'ended' : 'interrupted'})`, () => {
      const selected = { type: 'stage.leaved' as const, stageId: 1, facts: { 'response.chat.clientFrames': streamFact(3) } };
      const events = toNdjson(encodeRun([
        { type: 'stage.entered', stageId: 1, name: 'emit', parentStageId: null, facts: {} },
        { type: 'stream.frame', streamId: 1, frames: [{ type: 'event', event: { text: 'upstream' } }] },
        { type: 'stream.end', streamId: 1 },
        ...collected ? [] : [selected],
        { type: 'stream.frame', streamId: 3, frames: [{ type: 'event', event: { text: 'client' } }, { type: 'done' }] },
        ...ended ? [{ type: 'stream.end' as const, streamId: 3 }] : [],
        { type: 'stream.frame', streamId: 2, frames: [{ type: 'event', event: { text: 'intermediate' } }] },
        { type: 'stream.end', streamId: 2 },
        ...collected ? [selected] : [],
      ]));
      expect(clientStreamOf(events)).toEqual({
        events: [
          { ts: 0, frame: { type: 'event', event: { text: 'client' } } },
          { ts: 0, frame: { type: 'done' } },
        ],
        ended,
      });
    });
  }
}

test('keeps a selected empty stream and distinguishes it from no client stream', () => {
  expect(clientStreamOf(toNdjson(encodeRun([
    { type: 'stage.entered', stageId: 1, name: 'emit', parentStageId: null, facts: {} },
    { type: 'stage.leaved', stageId: 1, facts: { 'response.chat.clientFrames': streamFact(1) } },
    { type: 'stream.end', streamId: 1 },
  ])))).toEqual({ events: [], ended: true });
  expect(clientStreamOf(toNdjson(encodeRun([
    { type: 'stage.entered', stageId: 1, name: 'emit', parentStageId: null, facts: {} },
    { type: 'stage.leaved', stageId: 1, facts: { 'response.chat.clientFrames': null } },
  ])))).toBeNull();
});
