import type { RunEvent } from '@floway-dev/pipeline';

export type NumberTag = 'NaN' | 'Infinity' | '-Infinity' | '-0';
export type StoredRecord = { readonly [key: string]: StoredValue };
export type StoredValue = null | boolean | number | string | StoredRecord | readonly StoredValue[];

type Event<K extends RunEvent['k']> = Extract<RunEvent, { readonly k: K }>;
type StoredFields<T> = T extends RunEvent
  ? { [K in keyof T]: K extends 'facts' | 'error' | 'fields' | 'value' ? StoredValue : T[K] }
  : never;

export type StoredRunEvent = StoredFields<Exclude<RunEvent, Event<'frame'>>>;
export type StoredDone = Extract<StoredRunEvent, { readonly k: 'done' }>;
export interface StoredFrame {
  readonly seq: number;
  readonly tMs: number;
  readonly v: StoredValue;
}

export type EncodedDumpEvent = StoredRunEvent
  | { readonly k: 'obj'; readonly from: number; readonly nodes: readonly StoredValue[] }
  | { readonly k: 'frames'; readonly streamId: number; readonly frames: readonly StoredFrame[] }
  | { readonly k: 'truncated'; readonly seq: number; readonly tMs: number; readonly reason: 'size-limit' };
