import type { RunEvent } from '@floway-dev/pipeline';

export interface SecretFields {
  readonly length: number;
  readonly redacted: string;
  readonly hash: string;
}

export interface RawJsonLiteral { readonly rawJSON: string }

export const numbers = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 } as const;
export const jsonNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export interface ObjectReference { readonly $: number }

export type EncodedValue = null | boolean | number | string | ObjectReference
  | { readonly $stream: number }
  | { readonly $deferred: number }
  | { readonly $undefined: true }
  | { readonly $number: keyof typeof numbers };

export type ObjectNode = { readonly [key: string]: EncodedValue }
  | readonly EncodedValue[]
  | { readonly $bytes: string }
  | { readonly $secret: SecretFields }
  | RawJsonLiteral;

export type DumpLog<T> = Omit<Extract<RunEvent, { type: 'log' }>, 'fields' | 'error'> & {
  readonly fields: T;
  readonly error?: T;
};

export type DumpEvent =
  | { readonly type: 'object'; readonly fromObjectId: number; readonly nodes: readonly ObjectNode[] }
  | { readonly type: 'stage.entered'; readonly stageId: number; readonly name: string; readonly parentStageId?: number; readonly facts: ObjectReference }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly facts: ObjectReference }
  | { readonly type: 'stage.leaved'; readonly stageId: number; readonly error: EncodedValue }
  | { readonly type: 'stream.frame'; readonly streamId: number; readonly item: ObjectReference }
  | { readonly type: 'stream.end'; readonly streamId: number; readonly error?: EncodedValue }
  | { readonly type: 'deferred.settled'; readonly deferredId: number; readonly value: EncodedValue }
  | { readonly type: 'deferred.settled'; readonly deferredId: number; readonly error: EncodedValue }
  | DumpLog<EncodedValue>;
