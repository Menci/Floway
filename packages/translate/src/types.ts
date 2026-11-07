import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface SidecarCodec {
  /** Encode and decode must preserve sidecar tagged values, byte arrays, and raw JSON values. */
  encode: (payload: NonNullable<unknown> | null) => Promise<string>;
  decode: (encoded: string) => Promise<unknown>;
}

export interface RemoteImageData {
  mediaType: string | null;
  data: Uint8Array;
}

export type RemoteImageLoader = (url: string) => Promise<RemoteImageData | null>;

/**
 * Per-trip context. Carries the model name, the codec used by private sidecars,
 * and a per-pair-declared `TExtras`
 * shape that lists exactly the capability fields and runtime adapters the trip
 * reads. Pairs that need no extra fields use the default `unknown`. Callers
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
  readonly sidecarCodec: SidecarCodec;
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
 * Restates a failed upstream answer in the source protocol's own words.
 *
 * The caller hands over whatever the target upstream answered. This reads it
 * into the IR error payload, applies the source protocol's own rules, and
 * writes the envelope that protocol defines — the same wording and status its
 * stream would have produced. Returning `undefined` passes the upstream answer
 * through verbatim.
 */
export type SourceProtocolErrorWriter = (upstream: TranslatedApiError) => TranslatedApiError | undefined;

/**
 * What one translation trip hands back: the target payload, an events
 * translator closure mapping target-protocol events into source-protocol
 * events, and the source protocol's error writer.
 *
 * The target owns its mutable JSON objects and arrays. Downstream rules and
 * providers can mutate it while the source request and other trips remain
 * live, so pair builders clone values borrowed from their source.
 *
 * A failed upstream never reaches this result as bytes to rewrite: the caller
 * reads those bytes into the IR error payload first, and `errorBody` states the
 * result in the source protocol's envelope. That is the same model a
 * mid-stream error travels on, so both failures reach the client the same way.
 */
export interface TranslateTripResult<TgtPayload, SrcEvent, TgtEvent> {
  target: TgtPayload;
  events: (frames: AsyncIterable<ProtocolFrame<TgtEvent>>) => AsyncIterable<ProtocolFrame<SrcEvent>>;
  errorBody?: SourceProtocolErrorWriter;
}

/**
 * One internal target-specific translation trip. The function body owns the trip: it builds
 * the target payload and returns an events translator closure that maps
 * target-protocol events back into source-protocol events. Trip-scoped state
 * (synthetic ids, custom-tool name sets, etc.) lives as locals captured by
 * the returned closure — the source route never exposes them.
 *
 * `TExtras` is the pair-declared context surface: each pair lists exactly the
 * capabilities and injected runtime adapters it reads. Pairs that need no
 * extra context leave it as `unknown` (default).
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent, TExtras = unknown> = (
  src: SrcPayload,
  ctx: TranslationContext<TExtras>,
) => Promise<TranslateTripResult<TgtPayload, SrcEvent, TgtEvent>>;
