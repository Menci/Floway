import { expect, test } from 'vitest';

import { streamEventsOf } from '../../../src/components/requests/run-stream';
import { encodeRun, streamFact, toNdjson } from '@floway-dev/pipeline';

for (const collected of [true, false]) {
  test(`selects the client stream among upstream and intermediate frames (${collected ? 'collected' : 'streamed'})`, () => {
    const selected = { type: 'stage.leaved' as const, stageId: 1, facts: { 'response.chat.clientFrames': streamFact(3) } };
    const events = toNdjson(encodeRun([
      { type: 'stage.entered', stageId: 1, name: 'emit', parentStageId: null, facts: {} },
      { type: 'stream.frame', streamId: 1, frames: [{ type: 'event', event: { text: 'upstream' } }] },
      ...collected ? [] : [selected],
      { type: 'stream.frame', streamId: 3, frames: [{ type: 'event', event: { text: 'client' } }] },
      { type: 'stream.frame', streamId: 2, frames: [{ type: 'event', event: { text: 'intermediate' } }] },
      ...collected ? [selected] : [],
    ]));
    expect(streamEventsOf(events)).toEqual([{ ts: 0, frame: { type: 'event', event: { text: 'client' } } }]);
  });
}
