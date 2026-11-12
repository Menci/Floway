import type { DumpAccumulator } from '../../../dump/accumulator.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ExecuteResult } from '@floway-dev/provider';
import type { TranslateTrip, TranslateInputError } from '@floway-dev/translate';

// Capture target-protocol upstream data before translation so dumps use the target serializer.
export interface TranslationUpstreamCapture {
  upstreamFrame(frame: ProtocolFrame<unknown>): void;
  upstreamApiError(error: { status: number; headers: Headers; body: Uint8Array }): void;
}

// Stamp the target API before reading frames so an empty upstream stream retains its protocol identity.
export const captureFromDump = (
  dump: DumpAccumulator | null,
  targetApi: ChatTargetApi,
): TranslationUpstreamCapture | undefined => {
  if (dump === null) return undefined;
  dump.setUpstreamTargetApi(targetApi);
  return {
    upstreamFrame: frame => dump.upstreamFrame(frame),
    upstreamApiError: error => dump.upstreamApiError(error),
  };
};

// Source error rendering may recognize an upstream failure; undefined preserves it verbatim.
// Capture the target envelope before source rendering.
export const executeTranslation = async <SP extends object, TP, SE, TE>(
  payload: SP,
  translator: (p: Omit<SP, 'stream'> & { readonly stream: true }) => Promise<TranslateTrip<TP, SE, TE> | TranslateInputError>,
  innerAttempt: (translated: TP) => Promise<ExecuteResult<ProtocolFrame<TE>>>,
  capture?: TranslationUpstreamCapture,
): Promise<ExecuteResult<ProtocolFrame<SE>> | TranslateInputError> => {
  // A translation trip only produces a stream, so the upstream is always asked
  // for one. Whether the caller wanted a stream is a rendering decision made
  // after the trip returns; asking the upstream for a single body here would
  // leave the trip with an answer it has no path for. A source protocol whose
  // request states no stream field ignores the added key.
  const trip = await translator({ ...payload, stream: true as const });
  if (trip.type === 'input-error') return trip;
  const inner = await innerAttempt(trip.target);
  if (inner.type === 'events') {
    const events = capture === undefined
      ? inner.events
      : teeUpstreamFrames(inner.events, capture.upstreamFrame);
    return { ...inner, events: trip.events(events) };
  }
  if (inner.type === 'api-error' && inner.source === 'upstream') {
    capture?.upstreamApiError({ status: inner.status, headers: inner.headers, body: inner.body });
    const rewritten = trip.error(inner.status, inner.headers, inner.body);
    // Error renderers return JSON envelopes; this transport boundary encodes the response bytes.
    if (rewritten !== undefined) {
      return {
        ...inner,
        status: rewritten.status,
        headers: rewritten.headers,
        body: new TextEncoder().encode(JSON.stringify(rewritten.body)),
      };
    }
  }
  return inner;
};

// Tee that pushes each original target-protocol frame to the dump BEFORE
// handing it to `trip.events`. Lockstep with the downstream respond layer's
// iteration: as the respond layer pulls `result.events`, the tee pulls
// `inner.events`, captures, and yields; by the time `finalize`→`write` runs,
// the upstream frame log is complete. No buffering — one array push per frame.
const teeUpstreamFrames = async function* <T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  capture: (frame: ProtocolFrame<unknown>) => void,
): AsyncGenerator<ProtocolFrame<T>> {
  for await (const frame of events) {
    capture(frame);
    yield frame;
  }
};
