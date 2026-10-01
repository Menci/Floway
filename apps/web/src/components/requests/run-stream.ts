import { createRunReader, type DumpEvent } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface RecordedClientStream {
  readonly frames: readonly ProtocolFrame<unknown>[];
  readonly ended: boolean;
}

// Collected responses consume frames before the edge publishes its identifying fact;
// streaming responses consume them afterwards. Resolve the complete record before selecting.
export const clientStreamOf = (ndjson: string): RecordedClientStream | null => {
  const read = createRunReader();
  const streams = new Map<number, { frames: ProtocolFrame<unknown>[]; ended: boolean }>();
  let client: number | null = null;
  for (const line of ndjson.split('\n')) {
    if (line.length === 0) continue;
    const event = JSON.parse(line) as DumpEvent;
    const decoded = read(event);
    if ((event.type === 'stage.entered' || event.type === 'stage.leaved') && event.facts !== undefined) {
      for (const key of ['response.chat.clientFrames', 'response.openaiCompletions.rendered']) {
        if (!(key in event.facts)) continue;
        const selected = event.facts[key];
        client = selected !== null && typeof selected === 'object' && '$stream' in selected ? selected.$stream as number : null;
      }
    }
    if (event.type === 'stream.frame' || event.type === 'stream.end') {
      const stream = streams.get(event.streamId) ?? { frames: [], ended: false };
      if (event.type === 'stream.end') stream.ended = true;
      else for (const frame of decoded?.frames ?? []) stream.frames.push(frame as ProtocolFrame<unknown>);
      streams.set(event.streamId, stream);
    }
  }
  return client === null ? null : streams.get(client) ?? { frames: [], ended: false };
};
