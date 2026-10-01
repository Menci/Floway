import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface RemoteImageData {
  mediaType: string | null;
  data: Uint8Array;
}

export type RemoteImageLoader = (url: string) => Promise<RemoteImageData | null>;

/**
 * Per-trip context. Carries the model name plus a per-pair-declared `TExtras`
 * shape that lists exactly the capability fields and runtime adapters the trip
 * reads. Pairs that need no extra fields pass an empty object type. Callers
 * construct the context at the protocol boundary and inject runtime-owned
 * dependencies without making this package import their implementation.
 *
 * The client's stream preference is intentionally not in this context.
 * Translation always emits `stream: true` on the target payload; the LLM
 * upstream layer enforces SSE streaming and source protocol edges
 * collect a non-streamed downstream response when the client did not ask
 * for SSE.
 */
export type TranslationContext<TExtras = unknown> = {
  readonly model: string;
} & TExtras;

/** HTTP primitives supplied to a translation pair's optional error rewriter. Provider
 *  runtime types stay outside this package; the gateway owns the default source envelope. */
export interface TranslatedApiError {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

/** A translation's immutable target and trip-scoped response translators.
 *
 * Source and target values are immutable. Translation rebuilds changed protocol nodes and
 * shares unchanged subtrees; downstream rules and providers rebuild the paths they change.
 * An omitted error rewriter, or an undefined result, leaves source-envelope rendering to
 * the gateway. An explicit result supplies the pair's protocol-specific error mapping. */
export interface TranslateTripResult<TgtPayload, SrcEvent, TgtEvent> {
  target: TgtPayload;
  events: (frames: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
  apiError?: (upstream: TranslatedApiError) => TranslatedApiError | undefined;
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
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent, TExtras = unknown> = (
  src: SrcPayload,
  ctx: TranslationContext<TExtras>,
) => Promise<TranslateTripResult<TgtPayload, SrcEvent, TgtEvent>>;
