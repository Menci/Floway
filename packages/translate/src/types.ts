import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface SidecarCodec {
  /** Encode and decode must preserve sidecar tagged values, byte arrays, and raw JSON values. */
  encode: (payload: NonNullable<unknown> | null) => Promise<string>;
  decode: (encoded: string) => Promise<unknown>;
}

/**
 * What a translation trip needs from the data plane.
 *
 * Every field comes from outside this package: the codec that carries private
 * sidecars, and the operator's own output limit. A caller passes the same
 * object to every trip it starts.
 *
 * No model travels here: every translated request states its own, and a
 * protocol whose wire keeps it out of the body (GenerateContent names it in the
 * URL) is handed it as part of the request the caller built.
 *
 * The client's stream preference is intentionally not here. Translation always
 * emits `stream: true` on the target payload; the LLM upstream layer enforces
 * SSE streaming and source `respond.ts` boundaries collect a non-streamed
 * downstream response when the client did not ask for SSE.
 */
export interface TranslateOptions {
  readonly sidecarCodec: SidecarCodec;
  // The upstream's own output limit, when the operator knows it. A target that
  // requires a ceiling uses it when the source stated none.
  readonly fallbackMaxOutputTokens?: number;
}

export type ApiErrorTranslator = (status: number, headers: Headers, body: Uint8Array) => {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
} | undefined;

/** A prepared request and the two paths that translate its upstream answer. */
export interface TranslateTrip<TargetPayload, SourceEvent, TargetEvent> {
  readonly type: 'trip';
  readonly target: TargetPayload;
  readonly events: (frames: AsyncIterable<ProtocolFrame<TargetEvent>>) => AsyncIterable<ProtocolFrame<SourceEvent>>;
  readonly error: ApiErrorTranslator;
}

export interface TranslateInputError {
  readonly type: 'input-error';
  readonly message: string;
  readonly param?: string;
  readonly code?: string;
}

export type Translator<SourcePayload, SourceEvent, TargetPayload, TargetEvent> = (
  payload: SourcePayload,
  options: TranslateOptions,
) => Promise<TranslateTrip<TargetPayload, SourceEvent, TargetEvent> | TranslateInputError>;

// Expected input failures are caught at the package's public operations. Internal
// reader and writer helpers can abort without spreading a result union through
// every intermediate transformation.
export class TranslateInputException extends Error {
  readonly failure: TranslateInputError;

  constructor(message: string, options?: Omit<TranslateInputError, 'type' | 'message'>) {
    super(message);
    this.name = 'TranslateInputException';
    this.failure = { type: 'input-error', message, ...options };
  }
}
