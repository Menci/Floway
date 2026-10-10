import type { IR, IRJSONValue, IRJSONObject } from './ir.ts';
import { cloneIRJSON } from './json.ts';

export type IRPath = readonly (string | number)[];
export type IROperation =
  | { type: 'operation'; operation: 'assign'; path: IRPath; value: IRJSONValue }
  | { type: 'operation'; operation: 'append'; path: IRPath; value: string | IRJSONValue[] };
export type IREvent =
  | { type: 'start'; id: string; model: string; created?: number }
  | { type: 'item_start' | 'item_end'; choice: number; item: number }
  | { type: 'part_start' | 'part_end'; choice: number; item: number; part: number }
  | { type: 'choice_end'; choice: number; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' }
  | { type: 'finish'; status: 'completed' | 'incomplete' | 'failed'; error?: IRJSONObject }
  | { type: 'error'; error: IRJSONObject }
  | { type: 'ping' };
export type IRRecord = IROperation | IREvent;
export interface IRFrame { records: IRRecord[] }

export const getIRValue = (root: unknown, path: IRPath): unknown => {
  let value = root;
  for (const key of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) throw new TypeError(`Missing IR path: ${JSON.stringify(path)}`);
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
};

export const applyIROperation = (state: IR, operation: IROperation): void => {
  const key = operation.path.at(-1);
  if (key === undefined) throw new TypeError('IR operations require a property path');
  const parent = getIRValue(state, operation.path.slice(0, -1));
  if (typeof parent !== 'object' || parent === null) throw new TypeError('IR operation parent must be an object or array');
  if (Array.isArray(parent) && (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > parent.length)) throw new TypeError('IR array operation requires a contiguous nonnegative index');
  const target = parent as Record<string | number, unknown>;
  const value = cloneIRJSON(operation.value);
  if (operation.operation === 'assign') {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  } else if (typeof target[key] === 'string' && typeof value === 'string') {
    target[key] += value;
  } else if (Array.isArray(target[key]) && Array.isArray(value)) {
    (target[key] as unknown[]).push(...value);
  } else throw new TypeError('IR append requires a matching string or array target');
};

export const createIRBuilder = () => {
  const state: IR = { choices: [], extensions: {} };
  let records: IRRecord[] = [];
  const operation = (op: IROperation): void => {
    applyIROperation(state, op);
    records.push(op);
  };
  const assign = (path: IRPath, value: unknown): void => operation({ type: 'operation', operation: 'assign', path, value: cloneIRJSON(value) as IRJSONValue });
  const append = (path: IRPath, value: string | unknown[]): void => operation({ type: 'operation', operation: 'append', path, value: cloneIRJSON(value) as string | IRJSONValue[] });
  const event = (value: IREvent): void => { records.push(value); };
  const drain = (): IRFrame => {
    const frame = { records };
    records = [];
    return frame;
  };
  const choice = (index: number): void => {
    while (state.choices.length <= index) append(['choices'], [{ items: [] }]);
  };
  const item = (index: number, value: unknown): number => {
    choice(index);
    const position = state.choices[index].items.length;
    append(['choices', index, 'items'], [value]);
    event({ type: 'item_start', choice: index, item: position });
    return position;
  };
  return { state, assign, append, event, drain, choice, item };
};

export type IRBuilder = ReturnType<typeof createIRBuilder>;

export const reconcileIRValue = (builder: IRBuilder, path: IRPath, previous: unknown, next: unknown): void => {
  if (Object.is(previous, next)) return;
  if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous)) {
    builder.append(path, next.slice(previous.length));
  } else if (Array.isArray(previous) && Array.isArray(next) && next.length >= previous.length) {
    previous.forEach((value, index) => reconcileIRValue(builder, [...path, index], value, next[index]));
    if (next.length > previous.length) builder.append(path, next.slice(previous.length));
  } else if (previous !== null && next !== null && typeof previous === 'object' && typeof next === 'object' && !Array.isArray(previous) && !Array.isArray(next) && Object.keys(previous).every(key => Object.hasOwn(next, key))) {
    for (const [key, value] of Object.entries(next)) reconcileIRValue(builder, [...path, key], (previous as Record<string, unknown>)[key], value);
  } else builder.assign(path, next);
};

export const consumeIRRecords = async function* (frames: AsyncIterable<IRFrame>): AsyncGenerator<{ state: IR; record: IRRecord }> {
  const state: IR = { choices: [], extensions: {} };
  let started = false;
  let finished = false;
  for await (const frame of frames) for (const record of frame.records) {
    if (finished) throw new Error('IR record arrived after finish');
    if (record.type === 'operation') applyIROperation(state, record);
    else if (record.type === 'start') {
      if (started) throw new Error('Duplicate IR start');
      started = true;
    } else if (record.type === 'finish') {
      if (!started) throw new Error('IR finish arrived before start');
      finished = true;
    } else if (record.type === 'error') finished = true;
    yield { state, record };
  }
  if (!finished) throw new Error('IR stream ended without finish');
};
