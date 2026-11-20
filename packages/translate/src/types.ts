import type { SidecarCodec } from './round-trip/codec.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

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

/**
 * A translated request and the adapters that carry its response back.
 *
 * Source and target values are immutable. Translation never writes into the
 * payload, frames, or options it receives: it rebuilds each node it changes and
 * shares every unchanged subtree, so `target` may share structure with the
 * source payload and with other trips. A caller that needs a different value
 * rebuilds it the same way.
 */
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
