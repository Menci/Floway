import { irPathKey, irRecordOwnerPaths } from './operation-paths.ts';
import type { IRPath, IRRecord } from './stream.ts';

// Finds the unit that a record belongs to. A writer registers each unit at the path
// where its IR structure was initialized.
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

// Units wait here until the writer can open them, and are opened in IR order.
export interface IRQueuedUnit<T> { nextPending?: T }

export const createIRUnitQueue = <T extends IRQueuedUnit<T>>() => {
  let head: T | undefined;
  let tail: T | undefined;
  return {
    get head(): T | undefined { return head; },
    enqueue: (unit: T): void => {
      if (tail === undefined) head = unit;
      else tail.nextPending = unit;
      tail = unit;
    },
    // Removes the head unit, which the caller has just opened or discarded.
    dequeue: (): void => {
      const unit = head!;
      head = unit.nextPending;
      unit.nextPending = undefined;
      if (head === undefined) tail = undefined;
    },
  };
};

export type IRUnitQueue<T extends IRQueuedUnit<T>> = ReturnType<typeof createIRUnitQueue<T>>;
