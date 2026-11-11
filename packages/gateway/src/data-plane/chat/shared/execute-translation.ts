import type { DumpAccumulator } from '../../../dump/accumulator.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ExecuteResult } from '@floway-dev/provider';
import type { TranslateTrip, TranslateInputError } from '@floway-dev/translate';

// Protocol-agnostic capture hook for the pre-translation (target-protocol)
// upstream view. `executeTranslation` invokes it as it relays the inner
// attempt's frames/bytes through `trip.events`; the call site constructs one
// from its `(ctx.dump, targetApi)` via `captureFromDump`. The target protocol
// is statically known at every call site (the enclosing `if`/`case` branch),
// so the dashboard can render the captured frames with the right per-protocol
// serializer without re-deriving it from the client path.
export interface TranslationUpstreamCapture {
  upstreamFrame(frame: ProtocolFrame<unknown>): void;
  upstreamApiError(error: { status: number; headers: Headers; body: Uint8Array }): void;
}

// `dump` is null when the api key opts out of dumps; returns `undefined` so
// `executeTranslation` skips all upstream capture work (no tee, no api-error
// copy) — zero per-request cost on that path. `targetApi` is stamped eagerly so
// `meta.targetApi` is set even when the upstream stream produces zero frames.
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

// On an upstream api-error, `trip.error` translates the source envelope so
// the pair can rewrite the body into the source protocol's envelope — the
// canonical case is `anthropic-messages-via-*` translating an upstream context-window
// error into the Anthropic `prompt is too long:` shape Claude Code recognizes
// for auto-compaction. Returning `undefined` passes the upstream body through verbatim.
//
// When `capture` is provided, the ORIGINAL target-protocol frames (events
// path) or the verbatim upstream api-error envelope (api-error path) are tee'd
// to the dump BEFORE translation/rewrite, so the dump records what the upstream
// actually sent independent of what Floway translated it into.
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
  // Capture the ORIGINAL upstream api-error envelope before the source
  // protocol restates it. Fires for EVERY upstream api-error — even when the
  // trip states none — because the verbatim target-protocol body is still the
  // pre-translation view operators need to diagnose upstream behavior.
  if (inner.type === 'api-error' && inner.source === 'upstream') {
    capture?.upstreamApiError({ status: inner.status, headers: inner.headers, body: inner.body });
    const rewritten = trip.error(inner.status, inner.headers, inner.body);
    // A restated failure is a JSON envelope, not bytes: the transport encodes
    // it here, the only place a response body becomes wire form.
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
