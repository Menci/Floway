import type { SidecarCodec } from './round-trip/codec.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

export interface RemoteImageData {
  mediaType: string | null;
  data: Uint8Array;
}

export type RemoteImageLoader = (url: string) => Promise<RemoteImageData | null>;

/** Runtime dependencies and target-specific settings for one translation. */
export type TranslateOptions<TExtras = unknown> = {
  readonly model: string;
  readonly sidecarCodec: SidecarCodec;
} & TExtras;

export type ApiErrorTranslator = (status: number, headers: Headers, body: Uint8Array) => {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
} | undefined;

/**
 * The target owns its mutable JSON objects and arrays. Providers can mutate it
 * while the source request and other trips remain live, so builders clone values
 * borrowed from their source.
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

export type Translator<SourcePayload, SourceEvent, TargetPayload, TargetEvent, TExtras = unknown> = (
  payload: SourcePayload,
  options: TranslateOptions<TExtras>,
) => Promise<TranslateTrip<TargetPayload, SourceEvent, TargetEvent> | TranslateInputError>;
