import { irPathKey, irRecordOwnerPaths } from './operation-paths.ts';
import type { IRPath, IRRecord } from './records.ts';

// Finds the unit that a record belongs to. A writer registers each unit at the path
// where its output IR structure was initialized.
export const createIRUnitRegistry = <T>() => {
  const units = new Map<string, T>();
  return {
    set: (path: IRPath, unit: T): void => { units.set(irPathKey(path), unit); },
    get: (path: IRPath): T | undefined => units.get(irPathKey(path)),
    has: (path: IRPath): boolean => units.has(irPathKey(path)),
    delete: (path: IRPath): void => { units.delete(irPathKey(path)); },
    forRecord: (record: IRRecord, root: unknown): T | undefined => {
      for (const path of irRecordOwnerPaths(record, root)) {
        const unit = units.get(irPathKey(path));
        if (unit !== undefined) return unit;
      }
      return undefined;
    },
  };
};

// The queue's own link, so the units it carries stay plain values.
interface QueuedNode<T> {
  readonly value: T;
  next?: QueuedNode<T>;
}

// Units wait here until the writer can open them, and are opened in output IR order.
export const createIRUnitQueue = <T>() => {
  let head: QueuedNode<T> | undefined;
  let tail: QueuedNode<T> | undefined;
  return {
    get head(): T | undefined { return head?.value; },
    enqueue: (unit: T): void => {
      const node: QueuedNode<T> = { value: unit };
      if (tail === undefined) head = node;
      else tail.next = node;
      tail = node;
    },
    // Removes the head unit, which the caller has just opened or discarded.
    dropHead: (): void => {
      head = head!.next;
      if (head === undefined) tail = undefined;
    },
  };
};

export type IRUnitQueue<T> = ReturnType<typeof createIRUnitQueue<T>>;
