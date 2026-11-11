import { createIRCollector } from './collector.ts';
import { irItemPath, irPartPath, irPathKey, irUnitPath } from './operation-paths.ts';
import type { IREvent, IRPath, IRRecord, IRWrite } from './records.ts';
import type { IROutputUsage, IROutputValue } from './types.ts';

export type IRRelativePath = string | IRPath;

export interface IRWriteHandle {
  readonly path: IRPath;
  readonly index: number;
  append: (path: IRRelativePath, value: string, textFragmentIds?: readonly number[]) => void;
  assign: (path: IRRelativePath, value: unknown) => void;
  initialize: (path: IRRelativePath, value: unknown) => void;
  ensure: (path: IRRelativePath, initialValue: unknown) => void;
  absolutePath: (path: IRRelativePath) => IRPath;
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
}

/**
 * Builds the output IR as a target protocol reports it.
 *
 * A choice's index is its position in the request's candidate list, and a
 * stream that starts at index 1 states a choice 0 it never mentioned. The
 * builder therefore admits only the next index it has not yet opened: the
 * upstream's own count is what decides how many there are, and a protocol that
 * reports an index out of order is malformed rather than merely large.
 */
export const createIRBuilder = () => {
  const collector = createIRCollector();
  const { state } = collector;
  let records: IRRecord[] = [];
  const initialized = new Set<string>();
  const choices = new Map<number, IRChoiceHandle>();
  const itemCounts = new Map<number, number>();
  const partCounts = new Map<string, number>();

  const remember = (path: IRPath, value: unknown): void => {
    initialized.add(irPathKey(path));
    if (typeof value !== 'object' || value === null) return;
    for (const [key, child] of Object.entries(value)) remember([...path, Array.isArray(value) ? Number(key) : key], child);
  };
  const write = (value: IRWrite): void => { if (collector.applyWrite(value)) records.push(value); };
  // A handle accepts any caller value; the collector is what decides whether it
  // is a legal output IR value, so the write record states what was handed over
  // and validation runs on the way in.
  const assign = (path: IRPath, value: unknown): void => {
    write({ type: 'write', kind: 'assign', path, value: value as IROutputValue });
    remember(path, value);
  };
  const initialize = (path: IRPath, value: unknown): void => {
    write({ type: 'write', kind: 'initialize', path, value: value as IROutputValue });
    remember(path, value);
  };
  const append = (path: IRPath, value: string, textFragmentIds?: readonly number[]): void => write({
    type: 'write',
    kind: 'append',
    path,
    value,
    ...(textFragmentIds === undefined ? {} : { textFragmentIds: [...textFragmentIds] }),
  });
  const event = (value: IREvent): void => { collector.applyEvent(value); records.push(value); };
  const drain = (): readonly IRRecord[] => { const drained = records; records = []; return drained; };
  const relativePath = (base: IRPath, path: IRRelativePath): IRPath => [...base, ...typeof path === 'string' ? [path] : path];
  const writeHandle = (path: IRPath, index: number): IRWriteHandle => ({
    path,
    index,
    append: (subpath, value, textFragmentIds) => append(relativePath(path, subpath), value, textFragmentIds),
    assign: (subpath, value) => assign(relativePath(path, subpath), value),
    initialize: (subpath, value) => initialize(relativePath(path, subpath), value),
    ensure: (subpath, initialValue) => {
      const target = relativePath(path, subpath);
      if (initialized.has(irPathKey(target))) return;
      initialize(target, initialValue);
    },
    absolutePath: subpath => relativePath(path, subpath),
    current: subpath => collector.value(relativePath(path, subpath)),
  });
  // Usage arrives as cumulative snapshots, so each reported field replaces the previous one.
  const usage = (fields: IROutputUsage): void => {
    if (state.usage === undefined) initialize(['usage'], {});
    for (const [key, value] of Object.entries(fields)) assign(['usage', key], value);
  };
  const choice = (index: number): IRChoiceHandle => {
    if (!Number.isSafeInteger(index) || index < 0 || index > choices.size) throw new RangeError(`output IR choice index is out of sequence: ${index}`);
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
        return partHandle;
      },
      end: status => {
        if (!open) return;
        for (const part of openParts) part.end();
        event({ type: 'item_end', choice: choiceIndex, item: position, ...(status === undefined ? {} : { status }) });
        open = false;
      },
    };
    return handle;
  };
  return { collector, state, initialize, assign, append, event, drain, usage, choice, item };
};
