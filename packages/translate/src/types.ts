import type { ProtocolFrame } from '@floway-dev/protocols/common';

/**
 * Per-trip context. Carries the model name plus a per-pair-declared `TCaps`
 * shape that lists exactly the capability fields the trip reads. Pairs that
 * need no extra capability fields pass an empty object type. Callers
 * (typically source serves) construct one wide context whose shape is the
 * union of every pair's TCaps and reuse it across the dispatch map.
 *
 * The client's stream preference is intentionally not in this context.
 * Translation always emits `stream: true` on the target payload; the LLM
 * upstream layer enforces SSE streaming and source `respond.ts` boundaries
 * collect a non-streamed downstream response when the client did not ask
 * for SSE.
 */
export type TranslationContext<TCaps = unknown> = {
  readonly model: string;
} & TCaps;

/**
 * A wire-shaped upstream error body handed to `TranslateTrip.apiError`. The
 * pair returns a same-shaped object to rewrite the outbound envelope, or
 * `undefined` to pass it through unchanged. The provider layer's
 * `ApiErrorResult` shape is intentionally not imported here — translate is a
 * leaf below provider, so we express the contract in bare HTTP-response
 * primitives and let the gateway compose it back into an `ApiErrorResult`.
 */
export interface TranslatedApiError {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/**
 * One pairwise translation trip. The function body owns the trip: it builds
 * the target payload and returns an events translator closure that maps
 * target-protocol events back into source-protocol events. Trip-scoped state
 * (synthetic ids, custom-tool name sets, etc.) lives as locals captured by
 * the returned closure — the source serve never sees them.
 *
 * Stateless pairs simply return a function reference for `events`. Stateful
 * pairs let the closure capture whatever locals the trip needs.
 *
 * `TCaps` is the pair-declared capability surface: each pair lists exactly
 * the fields it reads from `TranslationContext`. Pairs that do not need any
 * upstream capability data leave it as `unknown` (default).
 *
 * `apiError` is optional: when the target upstream returns a non-2xx HTTP
 * body (rather than an SSE stream), the pair may rewrite it into the source
 * protocol's envelope. Returning `undefined` — or omitting the field
 * entirely — passes the upstream body through verbatim, which is what most
 * pairs want.
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent, TCaps = unknown> = (
  src: SrcPayload,
  ctx: TranslationContext<TCaps>,
) => Promise<{
  target: TgtPayload;
  events: (frames: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
  apiError?: (upstream: TranslatedApiError) => TranslatedApiError | undefined;
}>;
