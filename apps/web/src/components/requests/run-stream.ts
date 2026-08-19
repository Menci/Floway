// The frames a run served, read back out of its own event stream.
//
// A record holds every stage and both directions; the frames the client was served are in it as
// `stream.frame` events, written against the run's object space. So collecting them is reading
// that space — which is what `createRunReader` is — and then handing the frames to the same
// collector the dashboard has always used.
//
// A run may hold more than one stream. What the client read is the one the family's edge teed,
// which is the first opened, so that is the one collected: a sub-request's stream belongs to the
// sub-request and would fold into a different answer.

import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';

/** The frames of the run's first stream, in the shape the collector reads. A record with no
 *  stream — a refusal, a turn answered from a value — has none, and collects to nothing. */
export const streamEventsOf = (ndjson: string): DumpStreamEvent[] => {
  const read = createRunReader();
  const events: DumpStreamEvent[] = [];
  let first: number | null = null;
  for (const line of ndjson.split('\n')) {
    if (line.length === 0) continue;
    let event: DumpEvent;
    try {
      event = JSON.parse(line) as DumpEvent;
    } catch {
      // A line this cannot parse is a line the collector cannot use either. The event list
      // beside it shows the record as stored, failure named, which is where a reader looks.
      continue;
    }
    const said = read(event);
    if (event.type !== 'stream.frame') continue;
    first ??= event.streamId;
    if (event.streamId !== first) continue;
    for (const frame of said?.frames ?? []) {
      events.push({ frame: frame as DumpStreamEvent['frame'], ts: 0 });
    }
  }
  return events;
};
