import { createIRCollector, type IRCollector } from './collector.ts';
import { irItemPath, irPartPath, irPathKey, irUnitPath } from './operation-paths.ts';
import type { IRErrorPayload, IRUsage, IRValue } from './types.ts';

export type IRPath = readonly (string | number)[];
export type IRWrite = Readonly<
  | { type: 'write'; kind: 'initialize'; path: IRPath; value: IRValue }
  | { type: 'write'; kind: 'assign'; path: IRPath; value: IRValue }
  | { type: 'write'; kind: 'append'; path: IRPath; value: string; referencePieceIds?: readonly number[] }>;
export type IREvent = Readonly<
  | { type: 'start'; id?: string; created?: number }
  | { type: 'item_end'; choice: number; item: number; status?: 'completed' | 'incomplete' }
  | { type: 'part_end'; choice: number; item: number; part: number }
  | { type: 'choice_end'; choice: number; finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' }
  | { type: 'finish'; status: 'completed' | 'incomplete' }
  | { type: 'error'; error: IRErrorPayload }
  | { type: 'ping' }>;
export type IRRecord = IRWrite | IREvent;

export type IRRelativePath = string | number | IRPath;

export interface IRWriteHandle {
  readonly path: IRPath;
  readonly index: number;
  append: (path: IRRelativePath, value: string, referencePieceIds?: readonly number[]) => void;
  assign: (path: IRRelativePath, value: unknown) => void;
  initialize: (path: IRRelativePath, value: unknown) => void;
  ensure: (path: IRRelativePath, initialValue: unknown) => void;
  resolve: (path: IRRelativePath) => IRPath;
  // Snapshot reconciliation needs the value accumulated from earlier upstream events.
  current: <T = unknown>(path: IRRelativePath) => T | undefined;
}

export interface IRPartHandle extends IRWriteHandle {
  readonly isOpen: boolean;
  end: () => void;
}

export interface IRItemHandle extends IRWriteHandle {
  readonly isOpen: boolean;
  part: (value: unknown) => IRPartHandle;
  end: (status?: 'completed' | 'incomplete') => void;
}

export interface IRChoiceHandle extends IRWriteHandle {
  readonly isOpen: boolean;
  end: (finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter') => void;
  // ChatCompletions annotations use coordinates across all text emitted for a choice.
  textParts: () => readonly { item: IRItemHandle; part: IRPartHandle; text: string }[];
}

export const createIRBuilder = (maxChoices = 1) => {
  if (!Number.isSafeInteger(maxChoices) || maxChoices <= 0) throw new RangeError(`IR maxChoices must be a positive safe integer: ${maxChoices}`);
  const collector = createIRCollector();
  const { state } = collector;
  let records: IRRecord[] = [];
  const initialized = new Set<string>();
  const choices = new Map<number, IRChoiceHandle>();
  const items = new Map<string, IRItemHandle>();
  const parts = new Map<string, IRPartHandle>();
  const itemCounts = new Map<number, number>();
  const partCounts = new Map<string, number>();

  const remember = (path: IRPath, value: unknown): void => {
    initialized.add(irPathKey(path));
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) remember([...path, Array.isArray(value) ? Number(key) : key], child);
  };
  const write = (value: IRWrite): void => { if (collector.apply(value)) records.push(value); };
  const assign = (path: IRPath, value: unknown): void => {
    write({ type: 'write', kind: 'assign', path, value: value as IRValue });
    remember(path, value);
  };
  const initialize = (path: IRPath, value: unknown): void => {
    write({ type: 'write', kind: 'initialize', path, value: value as IRValue });
    remember(path, value);
  };
  const append = (path: IRPath, value: string, referencePieceIds?: readonly number[]): void => write({
    type: 'write',
    kind: 'append',
    path,
    value,
    ...(referencePieceIds === undefined ? {} : { referencePieceIds: [...referencePieceIds] }),
  });
  const event = (value: IREvent): void => { collector.applyEvent(value); records.push(value); };
  const drain = (): readonly IRRecord[] => { const drained = records; records = []; return drained; };
  const relativePath = (base: IRPath, path: IRRelativePath): IRPath => [...base, ...Array.isArray(path) ? path : [path]];
  const writeHandle = (path: IRPath, index: number): IRWriteHandle => ({
    path,
    index,
    append: (subpath, value, referencePieceIds) => append(relativePath(path, subpath), value, referencePieceIds),
    assign: (subpath, value) => assign(relativePath(path, subpath), value),
    initialize: (subpath, value) => initialize(relativePath(path, subpath), value),
    ensure: (subpath, initialValue) => {
      const target = relativePath(path, subpath);
      if (initialized.has(irPathKey(target))) return;
      initialize(target, initialValue);
    },
    resolve: subpath => relativePath(path, subpath),
    current: subpath => collector.value(relativePath(path, subpath)),
  });
  // Usage arrives as cumulative snapshots, so each reported field replaces the previous one.
  const usage = (fields: IRUsage): void => {
    if (state.usage === undefined) initialize(['usage'], {});
    for (const [key, value] of Object.entries(fields)) assign(['usage', key], value);
  };
  const choice = (index: number): IRChoiceHandle => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= maxChoices) throw new RangeError(`IR choice index exceeds the configured choice count: ${index}`);
    while (choices.size <= index) {
      const choiceIndex = choices.size;
      const path = irUnitPath('choice', choiceIndex);
      initialize(path, { items: [] });
      let open = true;
      const handle: IRChoiceHandle = {
        ...writeHandle(path, choiceIndex),
        get isOpen() { return open; },
        end: finishReason => {
          if (!open) return;
          event({ type: 'choice_end', choice: choiceIndex, finish_reason: finishReason });
          open = false;
        },
        textParts: () => [...parts.values()].flatMap(part => {
          const itemHandle = items.get(irPathKey(part.path.slice(0, -2)));
          if (itemHandle?.path[1] !== choiceIndex) return [];
          const text = part.current<string>('text');
          return text === undefined ? [] : [{ item: itemHandle, part, text }];
        }),
      };
      choices.set(choiceIndex, handle);
      itemCounts.set(choiceIndex, 0);
    }
    return choices.get(index)!;
  };
  const item = (choiceIndex: number, value: unknown): IRItemHandle => {
    choice(choiceIndex);
    const position = itemCounts.get(choiceIndex)!;
    const path = irItemPath(choiceIndex, position);
    initialize(path, value);
    itemCounts.set(choiceIndex, position + 1);
    partCounts.set(irPathKey(path), 0);
    let open = true;
    const openParts: IRPartHandle[] = [];
    const handle: IRItemHandle = {
      ...writeHandle(path, position),
      get isOpen() { return open; },
      part: partValue => {
        const partIndex = partCounts.get(irPathKey(path))!;
        const partPath = irPartPath(choiceIndex, position, partIndex);
        initialize(partPath, partValue);
        partCounts.set(irPathKey(path), partIndex + 1);
        let partOpen = true;
        const partHandle: IRPartHandle = {
          ...writeHandle(partPath, partIndex),
          get isOpen() { return partOpen; },
          end: () => {
            if (!partOpen) return;
            event({ type: 'part_end', choice: choiceIndex, item: position, part: partIndex });
            partOpen = false;
          },
        };
        openParts.push(partHandle);
        parts.set(irPathKey(partPath), partHandle);
        return partHandle;
      },
      end: status => {
        if (!open) return;
        for (const part of openParts) part.end();
        event({ type: 'item_end', choice: choiceIndex, item: position, ...(status === undefined ? {} : { status }) });
        open = false;
      },
    };
    items.set(irPathKey(path), handle);
    return handle;
  };
  return { collector, state, initialize, assign, append, event, drain, usage, choice, item };
};

// Applies each record to a fresh collector and yields it together with the collector, so a
// writer sees the state as of that record. A well-formed stream is exactly one `start`, then
// records, then `finish` or `error`.
export const consumeIRRecords = async function* (records: AsyncIterable<IRRecord>): AsyncGenerator<{ record: IRRecord; collector: IRCollector }> {
  const collector = createIRCollector();
  let started = false;
  let finished = false;
  for await (const record of records) {
    if (finished) throw new Error('IR record arrived after finish');
    if (record.type === 'write') {
      collector.apply(record);
    } else {
      if (record.type === 'start') {
        if (started) throw new Error('Duplicate IR start');
        started = true;
      } else if (record.type === 'finish') {
        if (!started) throw new Error('IR finish arrived before start');
        finished = true;
      } else if (record.type === 'error') {
        finished = true;
      }
      collector.applyEvent(record);
    }
    yield { record, collector };
  }
  if (!finished) throw new Error('IR stream ended without finish');
};
