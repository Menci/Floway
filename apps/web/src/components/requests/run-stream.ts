import type { DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';

// Collected responses consume frames before the edge publishes its identifying fact;
// streaming responses consume them afterwards. Resolve the complete record before selecting.
export const streamEventsOf = (ndjson: string): DumpStreamEvent[] => {
  const read = createRunReader();
  const streams = new Map<number, DumpStreamEvent[]>();
  let client: number | null = null;
  for (const line of ndjson.split('\n')) {
    if (line.length === 0) continue;
    const event = JSON.parse(line) as DumpEvent;
    const decoded = read(event);
    if (decoded?.facts && 'response.chat.clientFrames' in decoded.facts) {
      const selected = decoded.facts['response.chat.clientFrames'] as { stream: number } | null;
      client = selected?.stream ?? null;
    }
    if (event.type === 'stream.frame') {
      const bucket = streams.get(event.streamId) ?? [];
      for (const frame of decoded?.frames ?? []) bucket.push({ frame: frame as DumpStreamEvent['frame'], ts: 0 });
      streams.set(event.streamId, bucket);
    }
  }
  return client === null ? [] : streams.get(client) ?? [];
};
