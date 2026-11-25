import type { DumpLog, SecretFields } from './wire.ts';

export class StreamReference {
  constructor(readonly streamId: number) {}
}

export class DeferredReference {
  constructor(readonly deferredId: number) {}
}

export class SecretDescription implements SecretFields {
  constructor(readonly length: number, readonly redacted: string, readonly hash: string) {}
}

export class RawNumber {
  constructor(readonly rawJSON: string) {}
}

export interface DumpFacts { readonly [key: string]: DumpValue }

export type DumpValue = null | undefined | string | number | boolean | Uint8Array
  | StreamReference | DeferredReference | SecretDescription | RawNumber
  | DumpFacts | readonly DumpValue[];

export interface StageEntry {
  readonly stageId: number;
  readonly name: string;
  readonly parentStageId?: number;
  readonly facts: DumpFacts;
}

export interface DumpPanic { readonly error: DumpValue }

export interface DumpStage {
  readonly entry: StageEntry;
  readonly outcome: { readonly facts: DumpFacts } | DumpPanic;
  readonly logs: readonly DumpLog<DumpValue>[];
}

export type DumpFrame = { readonly ok: true; readonly value: DumpValue }
  | { readonly ok: false; readonly error: DumpValue };

export interface DumpStream {
  readonly frames: readonly DumpFrame[];
  readonly outcome: { readonly error?: never } | DumpPanic;
}

export interface DumpDeferred {
  readonly outcome: { readonly value: DumpValue } | DumpPanic;
}

export interface DumpArchive {
  readonly rootStageId: number;
  readonly stages: ReadonlyMap<number, DumpStage>;
  readonly streams: ReadonlyMap<number, DumpStream>;
  readonly deferreds: ReadonlyMap<number, DumpDeferred>;
}

export const isDumpArray = (value: DumpValue): value is readonly DumpValue[] => Array.isArray(value);

export const isDumpFacts = (value: DumpValue): value is DumpFacts => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};
