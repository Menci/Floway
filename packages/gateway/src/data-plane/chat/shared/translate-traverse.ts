import type { DumpAccumulator } from '../../../dump/accumulator.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ExecuteResult } from '@floway-dev/provider';
import type { TranslateTripResult } from '@floway-dev/translate';

// Protocol-agnostic capture hook for the pre-translation (target-protocol)
// upstream view. `traverseTranslation` invokes it as it relays the inner
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
// `traverseTranslation` skips all upstream capture work (no tee, no api-error
// copy) — zero per-request cost on that path. `targetApi` is stamped eagerly so
// `meta.targetApi` is set even when the upstream stream produces zero frames.
export const captureFromDump = (
  dump: DumpAccumulator | null,
  targetApi: ChatTargetApi,
): TranslationUpstreamCapture | undefined => {
  if (dump === null) return undefined;
  dump.setUpstreamTargetApi(targetApi);
  const upstreamFrame = (frame: ProtocolFrame<unknown>) => dump.upstreamFrame(frame);
  const upstreamApiError = (error: { status: number; headers: Headers; body: Uint8Array }) => dump.upstreamApiError(error);
  return { upstreamFrame, upstreamApiError };
};

// Threads a translate trip around an inner attempt. The trip itself is async
// (the real `@floway-dev/translate` pair functions resolve a `Promise`), so
// `translate` returns the trip object behind a promise. The pair functions
// take `(src, ctx)`; this helper's `translate` parameter stays unary so each
// caller closes over its own `ctx` (`p => translateXViaY(p, ctx)`).
//
// On an upstream api-error the trip's optional `apiError` hook is invoked so
// the pair can rewrite the body into the source protocol's envelope — the
// canonical case is `anthropic-messages-via-*` translating an upstream context-window
// error into the Anthropic `prompt is too long:` shape Claude Code recognizes
// for auto-compaction. Pairs that don't set `apiError` (or return `undefined`)
// pass the upstream body through verbatim.
//
// When `capture` is provided, the ORIGINAL target-protocol frames (events
// path) or the verbatim upstream api-error envelope (api-error path) are tee'd
// to the dump BEFORE translation/rewrite, so the dump records what the upstream
// actually sent independent of what Floway translated it into.
export const traverseTranslation = async <SP, TP, SE, TE>(
  payload: SP,
  translate: (p: SP) => Promise<TranslateTripResult<TP, SE, TE>>,
  innerAttempt: (translated: TP) => Promise<ExecuteResult<ProtocolFrame<TE>>>,
  capture?: TranslationUpstreamCapture,
): Promise<ExecuteResult<ProtocolFrame<SE>>> => {
  const trip = await translate(payload);
  const inner = await innerAttempt(trip.target);
  if (inner.type === 'events') {
    const events = capture === undefined
      ? inner.events
      : teeUpstreamFrames(inner.events, capture.upstreamFrame);
    return { ...inner, events: trip.events(events) };
  }
  // Capture the ORIGINAL upstream api-error envelope before the optional
  // `trip.apiError` rewrite. Fires for EVERY upstream api-error — even when no
  // rewrite happens (trip.apiError undefined or returns undefined), because the
  // verbatim target-protocol body is still the pre-translation view operators
  // need to diagnose upstream behavior.
  if (inner.type === 'api-error' && inner.source === 'upstream') {
    capture?.upstreamApiError({ status: inner.status, headers: inner.headers, body: inner.body });
    if (trip.apiError !== undefined) {
      const rewritten = trip.apiError({ status: inner.status, headers: inner.headers, body: inner.body });
      if (rewritten !== undefined) return { ...inner, status: rewritten.status, headers: rewritten.headers, body: rewritten.body };
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
