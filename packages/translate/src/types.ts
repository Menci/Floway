import type { ProtocolFrame } from '@floway-dev/protocols/common';

/**
 * Per-trip context. Carries the model name plus a per-pair-declared `TExtras`
 * shape that lists exactly the capability fields and runtime adapters the trip
 * reads. Pairs that need no extra fields pass an empty object type. Callers
 * construct the context at the protocol boundary and inject runtime-owned
 * dependencies without making this package import their implementation.
 *
 * The client's stream preference is intentionally not in this context.
 * Translation always emits `stream: true` on the target payload; the LLM
 * upstream layer enforces SSE streaming and source `respond.ts` boundaries
 * collect a non-streamed downstream response when the client did not ask
 * for SSE.
 */
export type TranslationContext<TExtras = unknown> = {
  readonly model: string;
} & TExtras;

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
 * `TExtras` is the pair-declared context surface: each pair lists exactly the
 * capabilities and injected runtime adapters it reads. Pairs that need no
 * extra context leave it as `unknown` (default).
 *
 * `apiError` is optional: when the target upstream returns a non-2xx HTTP
 * body (rather than an SSE stream), the pair may rewrite it into the source
 * protocol's envelope. Returning `undefined` — or omitting the field
 * entirely — passes the upstream body through verbatim, which is what most
 * pairs want.
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent, TExtras = unknown> = (
  src: SrcPayload,
  ctx: TranslationContext<TExtras>,
) => Promise<{
  target: TgtPayload;
  events: (frames: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
  apiError?: (upstream: TranslatedApiError) => TranslatedApiError | undefined;
}>;
