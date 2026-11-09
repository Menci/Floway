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

/**
 * What a translation trip needs from the data plane.
 *
 * Every field here comes from outside this package: the codec that carries
 * private sidecars, the model the caller resolved, and the runtime adapters a
 * protocol may need to state a request. A protocol reads the ones it needs and
 * ignores the rest, so there is one context rather than one per pair — a caller
 * passes the same object to every trip it starts.
 *
 * No model travels here: every translated request states its own, and a
 * protocol whose wire keeps it out of the body (GenerateContent names it in the
 * URL) is handed it as part of the request the caller built.
 *
 * The client's stream preference is intentionally not in this context.
 * Translation always emits `stream: true` on the target payload; the LLM
 * upstream layer enforces SSE streaming and source `respond.ts` boundaries
 * collect a non-streamed downstream response when the client did not ask
 * for SSE.
 */
export interface TranslateContext {
  readonly sidecarCodec: SidecarCodec;
  // The upstream's own output limit, when the operator knows it. A target that
  // requires a ceiling uses it when the source stated none.
  readonly fallbackMaxOutputTokens?: number;
}

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
 * One translation trip: a source request in, a target request and a return
 * path out.
 *
 * The function body owns the trip. Everything it derives from the request — a
 * namespace map, a custom-tool name set — is a local captured by the returned
 * closures, so a caller sees only the payload and a way to translate events.
 */
export type TranslateTrip<SrcPayload, SrcEvent, TgtPayload extends { model: string }, TgtEvent> = (
  src: SrcPayload,
  ctx: TranslateContext,
) => Promise<TranslateTripResult<TgtPayload, SrcEvent, TgtEvent>>;

// A caller-input validation failure surfaced by a translator: the caller
// sent something the target protocol cannot represent (an unsupported
// content-part type, a role the target does not accept, a missing field
// the target requires, etc.). Distinct from a plain `Error` so the
// data-plane http handlers can return a protocol-shaped 400 envelope
// instead of routing the failure through the generic internal-error 502
// path. The optional `param` and `code` follow the OpenAI / Anthropic
// error-body convention.
export class TranslatorInputError extends Error {
  readonly param: string | undefined;
  readonly code: string | undefined;

  constructor(message: string, options?: { param?: string; code?: string }) {
    super(message);
    this.name = 'TranslatorInputError';
    this.param = options?.param;
    this.code = options?.code;
  }
}
