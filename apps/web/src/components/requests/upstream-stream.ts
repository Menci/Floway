import type { CollectedStream } from './stream-render';
import { decodeWebBase64 } from '../../lib/base-encoding';
import { errorMessage } from '../../lib/error-message';
import type { DumpBody, DumpStreamEvent } from '@floway-dev/gateway/dump-types';
import { isEventStreamMediaType, parseSSEStream, type SseFrame } from '@floway-dev/protocols/common';

// Parsed upstream SSE for one exchange: the events (for the "Events" tab),
// the collected result (for "Collected"), and any parse error (surfaced as a
// diagnostic). `null` events means the body was not SSE or parsing failed —
// the caller falls back to the raw bytes view.
export interface ExchangeStream {
  events: DumpStreamEvent[] | null;
  collected: CollectedStream | null;
  error: string | null;
}

interface ParsedStreamEvents {
  events: DumpStreamEvent[] | null;
  error: string | null;
}

// Parses an upstream exchange's captured raw bytes into the same `DumpStreamEvent[]`
// shape the gateway produces for the downstream client view, so the dashboard's
// "Events" and "Collected" tabs can surface for native turns too. Returns
// `events: null` (and no error) when the body is not an SSE media type, so the
// caller silently falls back to the existing "Formatted body" / "Raw bytes" views.
export const upstreamStreamEvents = async (body: DumpBody, contentType: string): Promise<ParsedStreamEvents> => {
  if (!isEventStreamMediaType(contentType)) return { events: null, error: null };

  let text: string;
  try {
    text = body.encoding === 'base64' ? new TextDecoder('utf-8', { fatal: true }).decode(decodeWebBase64(body.data)) : body.data;
  } catch (error) {
    return { events: null, error: errorMessage(error) };
  }

  // Drive the shared `parseSSEStream` (the same parser the gateway uses) over
  // the decoded text. `new Response(text).body` is the standard browser shape
  // for handing a string to a ReadableStream consumer. Each frame maps to a
  // `DumpStreamEvent` with `ts: 0`: raw SSE carries no per-frame timestamps.
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Response(text).body!;
  } catch (error) {
    return { events: null, error: errorMessage(error) };
  }

  const events: DumpStreamEvent[] = [];
  try {
    for await (const frame of parseSSEStream(stream)) {
      const mapped = sseFrameToEvent(frame);
      if (mapped.event) events.push(mapped.event);
      if (mapped.done) break;
    }
  } catch (error) {
    return { events: null, error: errorMessage(error) };
  }

  return { events, error: null };
};

const sseFrameToEvent = (frame: SseFrame): { event: DumpStreamEvent | null; done: boolean } => {
  const data = frame.data.trim();
  if (data === '') return { event: null, done: false };
  if (data === '[DONE]') return { event: { frame: { type: 'done' }, ts: 0 }, done: true };

  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch (error) {
    // Per-event tolerance: the display layer (`renderStreamEvents` → `EventList`)
    // already renders a per-event "JSON parse error" label. Carry the original
    // parse error on the frame so the serializer surfaces it rather than
    // aborting the whole stream (which would hide the events that did parse).
    return {
      event: {
        frame: {
          type: 'event',
          event: { type: 'parse_error', data, error: errorMessage(error), sseEvent: frame.event ?? null },
        },
        ts: 0,
      },
      done: false,
    };
  }

  // Some upstreams emit the event type only via the SSE `event:` header and
  // leave it off the JSON body (OpenAI Responses). Re-attach it so the
  // per-protocol serializer and reducer see a consistent shape.
  if (frame.event !== undefined && payload != null && typeof payload === 'object' && !('type' in (payload as Record<string, unknown>))) {
    payload = { ...(payload as Record<string, unknown>), type: frame.event };
  }

  return { event: { frame: { type: 'event', event: payload }, ts: 0 }, done: false };
};
