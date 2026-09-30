import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';

export interface RecordedClientStream {
  readonly events: readonly DumpStreamEvent[];
  readonly ended: boolean;
}

// Collected responses consume frames before the edge publishes its identifying fact;
// streaming responses consume them afterwards. Resolve the complete record before selecting.
export const clientStreamOf = (ndjson: string): RecordedClientStream | null => {
  const read = createRunReader();
  const streams = new Map<number, { events: DumpStreamEvent[]; ended: boolean }>();
  let client: number | null = null;
  for (const line of ndjson.split('\n')) {
    if (line.length === 0) continue;
    const event = JSON.parse(line) as DumpEvent;
    const decoded = read(event);
    if (decoded?.facts && 'response.chat.clientFrames' in decoded.facts) {
      const selected = decoded.facts['response.chat.clientFrames'] as { stream: number } | null;
      client = selected?.stream ?? null;
    }
    if (event.type === 'stream.frame' || event.type === 'stream.end') {
      const stream = streams.get(event.streamId) ?? { events: [], ended: false };
      if (event.type === 'stream.end') stream.ended = true;
      else for (const frame of decoded?.frames ?? []) stream.events.push({ frame: frame as DumpStreamEvent['frame'], ts: 0 });
      streams.set(event.streamId, stream);
    }
  }
  return client === null ? null : streams.get(client) ?? { events: [], ended: false };
};
