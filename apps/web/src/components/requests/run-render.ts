import { errorMessage } from '../../lib/error-message';
import type { DumpEvent } from '@floway-dev/gateway/dump-types';

// A pipelined turn is recorded as its whole run: one NDJSON line per event, in
// the order the run emitted them. A line is also one SSE `data:` payload, so
// what this reads out of a stored record is what a live observer would be handed
// frame by frame.

export interface RenderedRunEvent {
  /** The event's own kind — `stage.entered`, `object`, `stream.frame`, … */
  type: string;
  /** Which stage, object or stream it is about. Ids, not prose. */
  subject: string | null;
  text: string;
  parseError: string | null;
}

// Only three of the six name a stage, and each of the other three names its own
// namespace, so the subject is read off the event rather than looked up.
const subjectOf = (event: DumpEvent): string | null => {
  switch (event.type) {
  case 'stage.entered': return event.name;
  case 'stage.leaved':  return `#${event.stageId}`;
  case 'stage.log':     return event.level;
  case 'object':        return `#${event.fromObjectId}`;
  case 'stream.frame':
  case 'stream.end':    return `#${event.streamId}`;
  }
};

// A line the gateway wrote and this cannot parse is shown as it was stored, with
// the failure named: a record that renders as nothing would read as an empty run.
export const renderRunEvents = (ndjson: string): RenderedRunEvent[] =>
  ndjson.split('\n').filter(line => line.length > 0).map(line => {
    try {
      const event = JSON.parse(line) as DumpEvent;
      return {
        type: event.type,
        subject: subjectOf(event),
        text: JSON.stringify(event, null, 2),
        parseError: null,
      };
    } catch (error) {
      return { type: '', subject: null, text: line, parseError: errorMessage(error) };
    }
  });
