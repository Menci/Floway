import type { RunEvent } from '@floway-dev/pipeline';

export interface SecretDescription {
  readonly length: number;
  readonly redacted: string;
  readonly hash: string;
}

export interface RawJsonLiteral { readonly rawJSON: string }

export type NumberMarker = 'NaN' | 'Infinity' | '-Infinity' | '-0';
export type EncodedValue = null | boolean | number | string
  | { readonly $: number }
  | { readonly $stream: number }
  | { readonly $deferred: number }
  | { readonly $undefined: true }
  | { readonly $number: NumberMarker };

export type ObjectNode = { readonly [key: string]: EncodedValue }
  | readonly EncodedValue[]
  | { readonly $bytes: string }
  | { readonly $secret: SecretDescription }
  | RawJsonLiteral;

export type DumpResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: T };

export type DumpLog<T> = Omit<Extract<RunEvent, { type: 'log' }>, 'fields' | 'error'> & {
  readonly fields: T;
  readonly error?: T;
};

export type DumpEvent =
  | { readonly type: 'object'; readonly fromObjectId: number; readonly nodes: readonly ObjectNode[] }
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId?: number; readonly facts: EncodedValue }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: EncodedValue }
  | { readonly type: 'stage.panicked'; readonly stageId: number; readonly error: EncodedValue; readonly facts?: EncodedValue }
  | { readonly type: 'stream.frame'; readonly streamId: number; readonly item: DumpResult<EncodedValue> }
  | { readonly type: 'stream.end'; readonly streamId: number }
  | ({ readonly type: 'deferred.settled'; readonly deferredId: number } & DumpResult<EncodedValue>)
  | DumpLog<EncodedValue>;
