import { irPathKey } from './operation-paths.ts';
import type { IRUnit } from './operation-paths.ts';
import type { IRPath } from './records.ts';

export const createCounter = <K>() => {
  const counts = new Map<K, number>();
  return {
    get: (key: K): number => counts.get(key) ?? 0,
    increment: (key: K): void => { counts.set(key, (counts.get(key) ?? 0) + 1); },
    decrement: (key: K): void => {
      const count = counts.get(key);
      if (count === undefined) throw new TypeError(`output IR lifecycle counter underflow: ${String(key)}`);
      if (count === 1) counts.delete(key);
      else counts.set(key, count - 1);
    },
  };
};

// Tracks which units (choices, items and parts) are open or closed.
export const createLifecycle = () => {
  const open = new Set<string>();
  const closed = new Set<string>();
  const openChildren = createCounter<string>();

  const assertWritable = (units: readonly IRUnit[], path: IRPath): void => {
    for (const unit of units) if (closed.has(irPathKey(unit.path))) throw new TypeError(`output IR write targets a closed ${unit.kind}: ${irPathKey(path)}`);
  };

  // `units` ends with the unit that was initialized.
  const openUnit = (units: readonly IRUnit[]): void => {
    open.add(irPathKey(units[units.length - 1].path));
    if (units.length > 1) openChildren.increment(irPathKey(units[units.length - 2].path));
  };

  const closeUnit = (units: readonly IRUnit[]): void => {
    const unit = units[units.length - 1];
    const key = irPathKey(unit.path);
    if (!open.delete(key)) throw new TypeError(`output IR ${unit.kind} is not open: ${key}`);
    if (openChildren.get(key) !== 0) throw new TypeError(`output IR ${unit.kind} ended with an open unit inside it: ${key}`);
    closed.add(key);
    if (units.length > 1) openChildren.decrement(irPathKey(units[units.length - 2].path));
  };

  const assertFinishable = (): void => {
    if (open.size !== 0) throw new TypeError('output IR finish arrived with open units');
  };

  return { assertWritable, openUnit, closeUnit, assertFinishable, isOpen: (path: IRPath): boolean => open.has(irPathKey(path)), isClosed: (path: IRPath): boolean => closed.has(irPathKey(path)) };
};
