import type { IRErrorPayload } from './error.ts';
import type { IROutputValue } from './types.ts';

export type IRPath = readonly (string | number)[];
export type IRWrite = Readonly<
  | { type: 'write'; kind: 'initialize'; path: IRPath; value: IROutputValue }
  | { type: 'write'; kind: 'assign'; path: IRPath; value: IROutputValue }
  | { type: 'write'; kind: 'append'; path: IRPath; value: string; textFragmentIds?: readonly number[] }>;
export type IREvent = Readonly<
  | { type: 'start'; id?: string; created?: number }
  | { type: 'item_end'; choice: number; item: number; status?: 'completed' | 'incomplete' }
  | { type: 'part_end'; choice: number; item: number; part: number }
  | { type: 'choice_end'; choice: number; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' }
  | { type: 'finish'; status: 'completed' | 'incomplete' }
  | { type: 'error'; error: IRErrorPayload }
  | { type: 'ping' }>;
export type IRRecord = IRWrite | IREvent;
